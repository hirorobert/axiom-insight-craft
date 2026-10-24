/**
 * syntheticLgaFy2026Balances.fixture.ts
 *
 * INDEPENDENTLY INVENTED synthetic trial balance for an illustrative Tanzanian
 * local government entity, FY2026 (annual period ended 30 June). Every amount
 * was authored by hand for testing; none is taken, scaled, rounded or derived
 * from any entity's records. Account codes are natural account codes of the
 * public-sector MUSE chart that TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 recognises,
 * so classification resolves through the real rule pack.
 *
 * Balanced: total debits = total credits. The opening accumulated surplus
 * (63293101) is the invented figure that closes the trial balance.
 * Companion period: syntheticLgaFy2025Balances.fixture.ts (the comparative year).
 */

export interface Fy2026Balance {
  code: string;
  debit: number;
  credit: number;
}

export const SYNTHETIC_LGA_FY2026_BALANCES: Fy2026Balance[] = [
  { code: "11640172", debit: 0, credit: 1_250_000_000.0 }, // LEVIES
  { code: "12110105", debit: 0, credit: 96_250_000.0 }, // USER_FEES
  { code: "12120107", debit: 0, credit: 340_500_000.0 }, // USER_FEES
  { code: "13410101", debit: 0, credit: 18_400_000_000.0 }, // GOVERNMENT_SUBVENTIONS_AND_GRANTS
  { code: "13410102", debit: 0, credit: 2_150_000_000.0 }, // GOVERNMENT_SUBVENTIONS_AND_GRANTS
  { code: "13465104", debit: 0, credit: 3_800_000_000.0 }, // GOVERNMENT_SUBVENTIONS_AND_GRANTS
  { code: "14150101", debit: 0, credit: 42_750_000.0 }, // OWN_SOURCE_REVENUE_EXCHANGE_STATUS_UNCONFIRMED
  { code: "14220141", debit: 0, credit: 18_300_000.0 }, // EXCHANGE_REVENUE_FEES_AND_CHARGES
  { code: "21111101", debit: 17_900_000_000.0, credit: 0 }, // EMPLOYEE_COSTS
  { code: "21112107", debit: 210_000_000.0, credit: 0 }, // EMPLOYEE_COSTS
  { code: "22001101", debit: 85_400_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22003102", debit: 120_000_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22010105", debit: 260_000_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22018107", debit: 175_600_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22033301", debit: 15_250_000.0, credit: 0 }, // IMPAIRMENT_EXPECTED_CREDIT_LOSS
  { code: "26312106", debit: 640_000_000.0, credit: 0 }, // GRANTS_TRANSFERS_EXPENSE
  { code: "27210104", debit: 32_500_000.0, credit: 0 }, // SOCIAL_BENEFITS
  { code: "61112102", debit: 9_600_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61112103", debit: 14_200_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61113101", debit: 5_300_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61121101", debit: 2_400_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61462102", debit: 0, credit: 2_880_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "61462103", debit: 0, credit: 4_260_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "61463101", debit: 0, credit: 1_590_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "61465101", debit: 0, credit: 1_080_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "31112102", debit: 410_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_ADDITIONS
  { code: "31112103", debit: 1_275_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_ADDITIONS
  { code: "31113102", debit: 365_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_ADDITIONS
  { code: "31710109", debit: 2_140_000_000.0, credit: 0 }, // WORK_IN_PROGRESS
  { code: "31710110", debit: 520_000_000.0, credit: 0 }, // WORK_IN_PROGRESS
  { code: "31710309", debit: 0, credit: 600_000_000.0 }, // WORK_IN_PROGRESS_TRANSFER_NON_CASH
  { code: "31710310", debit: 0, credit: 150_000_000.0 }, // WORK_IN_PROGRESS_TRANSFER_NON_CASH
  { code: "31510203", debit: 450_000_000.0, credit: 0 }, // INVESTMENT_PROPERTY
  { code: "31221101", debit: 64_000_000.0, credit: 0 }, // INVENTORIES
  { code: "31221102", debit: 138_000_000.0, credit: 0 }, // INVENTORIES
  { code: "32171120", debit: 47_500_000.0, credit: 0 }, // RECEIVABLES
  { code: "32171108", debit: 210_000_000.0, credit: 0 }, // RECEIVABLES
  { code: "32173113", debit: 0, credit: 26_000_000.0 }, // RECEIVABLES_ECL_PROVISION_CONTRA
  { code: "32171202", debit: 92_000_000.0, credit: 0 }, // PREPAYMENTS
  { code: "62123131", debit: 1_840_000_000.0, credit: 0 }, // CASH_AND_CASH_EQUIVALENTS
  { code: "62123133", debit: 765_000_000.0, credit: 0 }, // CASH_AND_CASH_EQUIVALENTS
  { code: "62123115", debit: 310_000_000.0, credit: 0 }, // CASH_AND_CASH_EQUIVALENTS
  { code: "62123231", debit: 0, credit: 4_500_000.0 }, // CASH_ECL_PROVISION_CONTRA
  { code: "33181102", debit: 0, credit: 685_000_000.0 }, // PAYABLES_AND_ACCRUALS
  { code: "33181103", debit: 0, credit: 94_000_000.0 }, // PAYABLES_AND_ACCRUALS
  { code: "33181109", debit: 0, credit: 310_000_000.0 }, // DEPOSITS_HELD
  { code: "33182107", debit: 0, credit: 21_640_000.0 }, // WITHHOLDING_TAX_PAYABLE
  { code: "33191110", debit: 0, credit: 1_120_000_000.0 }, // DEFERRED_REVENUE_INCOME
  { code: "63333501", debit: 0, credit: 2_500_000_000.0 }, // RESERVES
  { code: "63293101", debit: 0, credit: 18_146_310_000.0 }, // ACCUMULATED_SURPLUS_DEFICIT
];
