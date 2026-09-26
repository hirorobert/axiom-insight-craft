// kinga-comparative-engine — LEGACY NAME, compatibility adapter only.
//
// Kept so already-deployed callers keep working during the transition to comparative-assurance-engine. It contains
// no business logic of its own. RETIREMENT CONDITION: remove this function (and its deployment) once the platform
// logs show no request to it for 30 consecutive days after a frontend release that calls only
// comparative-assurance-engine has been live in production — a separate, explicitly approved change.
//
// Serves the one Comparative Assurance implementation in ../_shared/comparativeAssurance.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleComparativeAssurance } from "../_shared/comparativeAssurance.ts";

serve(handleComparativeAssurance);
