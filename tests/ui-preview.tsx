import { createRoot } from "react-dom/client";
import { IdeaBoard } from "@/app/components/IdeaBoard";
import "@/app/globals.css";

// Uses only the fixture API from ui-preview.config.ts, with no cloud credentials.
createRoot(document.getElementById("root")!).render(
  <IdeaBoard userId="design-qa-isolated" displayName="我" onSignOut={() => window.location.reload()} />,
);
