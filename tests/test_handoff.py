"""Real Git/TAR regression checks for portable handoff safety; no network or mocks."""

import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "create_handoff.py"


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="board-handoff-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ignore = self.root / "exclude.empty"
        self.ignore.touch()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        (self.repo / "README.md").write_bytes(b"handoff fixture\n")
        (self.repo / "中文.txt").write_bytes("保留原始源码\n".encode("utf-8"))
        (self.repo / ".gitignore").write_text(".env\nnode_modules/\n", encoding="utf-8")
        self.commit()
        self.output = self.root / "delivery.tar"

    def git(self, *args):
        result = subprocess.run(
            ["git", "-c", f"core.excludesFile={self.ignore}", "-c", "core.autocrlf=false", "-c", "user.name=Handoff Test",
             "-c", "user.email=handoff@example.invalid", *args], cwd=self.repo,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        return result.stdout.decode("utf-8").strip()

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "-qm", "fixture")

    def cli(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *map(str, args)],
                              capture_output=True, text=True, encoding="utf-8", timeout=30,
                              env={**os.environ, "PYTHONUTF8": "1"})

    def create(self, *args):
        return self.cli("create", "--repo", self.repo, "--output", self.output, *args)

    def test_archive_restores_source_unicode_and_full_git_commit(self):
        (self.repo / ".env").write_text("LOCAL_PRIVATE_VALUE=do-not-export", encoding="utf-8")
        (self.repo / "node_modules").mkdir()
        (self.repo / "node_modules" / "private.txt").write_text("ignored", encoding="utf-8")
        result = self.create()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["source_commit"], self.git("rev-parse", "HEAD"))
        with tarfile.open(self.output, "r:") as archive:
            names = archive.getnames()
            self.assertNotIn("board-handoff/source/.env", names)
            self.assertFalse(any("node_modules" in name or "/.git/" in name for name in names))
            self.assertEqual(archive.extractfile("board-handoff/source/中文.txt").read(),
                             "保留原始源码\n".encode())
            bundle = self.root / "source.bundle"
            bundle.write_bytes(archive.extractfile("board-handoff/repository.bundle").read())
        checkout = self.root / "restored"
        subprocess.run(["git", "clone", "-q", "-b", "main", str(bundle), str(checkout)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual((checkout / "中文.txt").read_text(encoding="utf-8"), "保留原始源码\n")
        restored_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout).decode().strip()
        self.assertEqual(restored_commit, report["source_commit"])
        verified = self.cli("verify", self.output)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertTrue(json.loads(verified.stdout)["verified"])

    def test_existing_output_is_never_overwritten(self):
        self.output.write_bytes(b"user-owned-existing-archive")
        result = self.create()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_bytes(), b"user-owned-existing-archive")

    def test_existing_checksum_is_preserved_without_publishing_archive(self):
        checksum = self.output.with_name(self.output.name + ".sha256")
        checksum.write_bytes(b"user-owned-checksum")
        result = self.create()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(checksum.read_bytes(), b"user-owned-checksum")
        self.assertFalse(self.output.exists())

    def test_concurrent_publish_has_one_winner_and_matching_checksum(self):
        command = [sys.executable, "-B", str(SCRIPT), "create", "--repo", str(self.repo),
                   "--output", str(self.output)]
        processes = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      env={**os.environ, "PYTHONUTF8": "1"}) for _ in range(2)]
        try:
            for process in processes:
                process.communicate(timeout=30)
            self.assertEqual(sorted(process.returncode for process in processes), [0, 1])
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        checksum = self.output.with_name(self.output.name + ".sha256").read_text(encoding="utf-8")
        self.assertEqual(checksum.split()[0], hashlib.sha256(self.output.read_bytes()).hexdigest())
        verified = self.cli("verify", self.output)
        self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_git_archive_attributes_cannot_omit_or_rewrite_tracked_source(self):
        (self.repo / ".gitattributes").write_bytes("README.md export-ignore\n中文.txt export-subst\n".encode())
        (self.repo / "中文.txt").write_bytes(b"$Format:%H$\n")
        self.commit()
        result = self.create()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.output) as archive:
            self.assertEqual(archive.extractfile("board-handoff/source/README.md").read(),
                             self.git("show", "HEAD:README.md").encode() + b"\n")
            self.assertEqual(archive.extractfile("board-handoff/source/中文.txt").read(), b"$Format:%H$\n")

    def test_changed_and_untracked_source_are_not_silently_lost(self):
        for kind in ("tracked", "untracked"):
            with self.subTest(kind=kind):
                path = self.repo / ("README.md" if kind == "tracked" else "new-source.txt")
                previous = path.read_bytes() if path.exists() else None
                path.write_bytes(b"not-yet-committed")
                result = self.create()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.output.exists())
                if previous is None:
                    path.unlink()
                else:
                    path.write_bytes(previous)

    def test_excluded_untracked_log_is_preserved_not_exported(self):
        log = self.repo / "error.log"
        log.write_bytes(b"diagnostic-private-data")
        result = self.create()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(log.read_bytes(), b"diagnostic-private-data")
        with tarfile.open(self.output) as archive:
            self.assertFalse(any(name.endswith("error.log") for name in archive.getnames()))

    def test_historical_secret_removed_from_head_still_blocks_bundle(self):
        old = self.repo / "old-secret.txt"
        old.write_text("ghp_" + "A" * 36, encoding="utf-8")
        self.commit()
        self.git("rm", "old-secret.txt")
        self.commit()
        result = self.create()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("credential", result.stderr.lower())
        self.assertFalse(self.output.exists())

    def test_shallow_repository_is_rejected_instead_of_creating_broken_bundle(self):
        (self.repo / "another.txt").write_bytes(b"second commit\n")
        self.commit()
        shallow = self.root / "shallow"
        result = subprocess.run(["git", "clone", "-q", "--depth", "1", "--no-local",
                                 self.repo.as_uri(), str(shallow)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.repo = shallow
        self.assertEqual(self.git("rev-parse", "--is-shallow-repository"), "true")
        result = self.create()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("shallow", result.stderr.lower())
        self.assertFalse(self.output.exists())

    def test_extra_paths_and_extra_secrets_are_rejected(self):
        extra = self.root / "extra.txt"
        extra.write_bytes(b"ordinary evidence")
        for name in ("../escape", "/absolute", "source/config.json", "source/.env"):
            with self.subTest(name=name):
                self.assertNotEqual(self.create("--extra", f"{name}={extra}").returncode, 0)
                self.assertFalse(self.output.exists())
        extra.write_text("github_pat_" + "A" * 50, encoding="utf-8")
        result = self.create("--extra", f"evidence/notes.txt={extra}")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())

    def test_verifier_rejects_content_tampering(self):
        created = self.create()
        self.assertEqual(created.returncode, 0, created.stderr)
        modified = self.root / "tampered.tar"
        with tarfile.open(self.output) as original, tarfile.open(modified, "w") as altered:
            for member in original.getmembers():
                data = original.extractfile(member).read()
                if member.name == "board-handoff/source/README.md":
                    data = b"tampered source\n"
                    member.size = len(data)
                altered.addfile(member, io.BytesIO(data))
        result = self.cli("verify", modified)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mismatch", result.stderr.lower())

    def test_verifier_rejects_missing_and_extra_members(self):
        created = self.create()
        self.assertEqual(created.returncode, 0, created.stderr)
        for kind in ("missing", "extra"):
            with self.subTest(kind=kind):
                changed = self.root / f"{kind}.tar"
                with tarfile.open(self.output) as original, tarfile.open(changed, "w") as altered:
                    for member in original:
                        if kind == "missing" and member.name.endswith("/README.md"):
                            continue
                        altered.addfile(member, io.BytesIO(original.extractfile(member).read()))
                    if kind == "extra":
                        altered.addfile(tarfile.TarInfo("board-handoff/extra.txt"), io.BytesIO(b""))
                result = self.cli("verify", changed)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("mismatch", result.stderr.lower())

    def test_verifier_rejects_oversize_before_reading_or_extracting(self):
        oversized = self.root / "oversized.tar"
        member = tarfile.TarInfo("board-handoff/huge.bin")
        member.size = 50 * 1024 * 1024 + 1
        oversized.write_bytes(member.tobuf() + b"\0" * 1024)
        result = self.cli("verify", oversized)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe", result.stderr.lower())

    def test_verifier_rejects_unsafe_links_and_duplicates_without_extracting(self):
        for kind in ("traversal", "symlink", "duplicate", "prefix"):
            with self.subTest(kind=kind):
                bad = self.root / f"bad-{kind}.tar"
                with tarfile.open(bad, "w") as archive:
                    name = "../outside.txt" if kind == "traversal" else "board-handoff/source/file"
                    member = tarfile.TarInfo(name)
                    if kind == "symlink":
                        member.type, member.linkname = tarfile.SYMTYPE, "../../outside.txt"
                    archive.addfile(member, io.BytesIO(b""))
                    if kind == "duplicate":
                        archive.addfile(member, io.BytesIO(b""))
                    if kind == "prefix":
                        archive.addfile(tarfile.TarInfo(name + "/child"), io.BytesIO(b""))
                result = self.cli("verify", bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unsafe", result.stderr.lower())
                self.assertFalse((self.root / "outside.txt").exists())

    def test_file_directory_prefix_collisions_are_rejected_in_both_orders(self):
        evidence = self.root / "notes.txt"
        evidence.write_bytes(b"test evidence")
        for index, names in enumerate((("evidence", "evidence/details.txt"),
                                       ("evidence/details.txt", "evidence"),
                                       ("Evidence", "evidence/details.txt"))):
            with self.subTest(names=names):
                self.output = self.root / f"collision-{index}.tar"
                result = self.create("--extra", f"{names[0]}={evidence}",
                                     "--extra", f"{names[1]}={evidence}")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unsafe", result.stderr.lower())
                self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
