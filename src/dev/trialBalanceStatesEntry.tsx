/** Development-only entry for dev/trial-balance-states.html. Never imported by the application (see the gallery). */
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "../index.css";
import TrialBalanceStatesGallery from "./TrialBalanceStatesGallery";

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={[`/${window.location.search}`]}>
      <TrialBalanceStatesGallery />
    </MemoryRouter>,
  );
}
