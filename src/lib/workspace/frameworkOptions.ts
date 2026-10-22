/** Persistable framework identities shared by company setup and portfolio labels. No release authority. */
export const FRAMEWORK_OPTIONS: { value: string; label: string; dbValue: string | null }[] = [
  { value: "decide_later",  label: "Decide later",                        dbValue: null },
  { value: "full_ifrs",     label: "Full IFRS",                           dbValue: "full_ifrs" },
  { value: "ifrs_for_smes", label: "IFRS for SMEs",                      dbValue: "ifrs_for_smes" },
  { value: "ipsas_accrual", label: "IPSAS — public sector (accrual)",    dbValue: "ipsas_accrual" },
  { value: "ipsas_cash",    label: "IPSAS — public sector (cash basis)", dbValue: "ipsas_cash" },
];
