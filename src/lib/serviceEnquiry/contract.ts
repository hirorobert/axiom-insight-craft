// The browser form and the Edge Function validate with the SAME module — there is one definition of what an enquiry may
// contain. It lives under supabase/functions/_shared because the Edge Function can only bundle files from there.
export * from "../../../supabase/functions/_shared/serviceEnquiryContract";
