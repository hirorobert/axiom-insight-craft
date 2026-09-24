// comparative-assurance-engine — the canonical Comparative Assurance endpoint (CFO Close).
//
// Serves the one Comparative Assurance implementation in ../_shared/comparativeAssurance.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleComparativeAssurance } from "../_shared/comparativeAssurance.ts";

serve(handleComparativeAssurance);
