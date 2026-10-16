#!/usr/bin/env node
// Launch-acceptance QA — CI entry (BLACK). Invoked by the "Real application end to end (local Supabase stack)" job, after
// the drafts journey, as NORMAL proposed:  node research/launch-qa/qa/realAppJourney.mjs <evidence-dir>
// It delegates to the runner in ../harness/launchAcceptance.mjs, which bootstraps the already-running local stack
// (`supabase status`), builds the candidate app isolated to it, serves it on 127.0.0.1:${LAUNCH_QA_PREVIEW_PORT:-4174}
// (NOT the drafts journey's 4173), and executes the nine scenarios. Records application + harness SHAs separately.
// Machine-readable exit: 0 all-passed · 1 any-FAIL · 4 nothing-executed. First-failure evidence (screenshot + DOM) is
// written next to <evidence-dir>. This file adds no logic; it is the stable CI entry path.
import "../harness/launchAcceptance.mjs";
