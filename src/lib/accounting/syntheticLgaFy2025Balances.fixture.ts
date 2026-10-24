/**
 * syntheticLgaFy2025Balances.fixture.ts
 *
 * INDEPENDENTLY INVENTED synthetic trial balance for an illustrative Tanzanian
 * local government entity, FY2025 (annual period ended 30 June). Every amount
 * was authored by hand for testing; none is taken, scaled, rounded or derived
 * from any entity's records. Account codes are natural account codes of the
 * public-sector MUSE chart that TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 recognises,
 * so classification resolves through the real rule pack.
 *
 * Balanced: total debits = total credits. The opening accumulated surplus
 * (63293101) is the invented figure that closes the trial balance.
 * Companion period: syntheticLgaFy2026Balances.fixture.ts (the following year).
 */

export interface Fy2025Balance {
  code: string;
  debit: number;
  credit: number;
}

export const SYNTHETIC_LGA_FY2025_BALANCES: Fy2025Balance[] = [
  { code: "11640172", debit: 0, credit: 1_105_000_000.0 }, // LEVIES
  { code: "12110105", debit: 0, credit: 81_400_000.0 }, // USER_FEES
  { code: "12120107", debit: 0, credit: 298_750_000.0 }, // USER_FEES
  { code: "13410101", debit: 0, credit: 17_250_000_000.0 }, // GOVERNMENT_SUBVENTIONS_AND_GRANTS
  { code: "13410102", debit: 0, credit: 1_980_000_000.0 }, // GOVERNMENT_SUBVENTIONS_AND_GRANTS
  { code: "13465101", debit: 0, credit: 2_600_000_000.0 }, // GOVERNMENT_SUBVENTIONS_AND_GRANTS
  { code: "14220141", debit: 0, credit: 15_900_000.0 }, // EXCHANGE_REVENUE_FEES_AND_CHARGES
  { code: "14210104", debit: 0, credit: 3_200_000.0 }, // OWN_SOURCE_REVENUE_EXCHANGE_STATUS_UNCONFIRMED
  { code: "21111101", debit: 16_800_000_000.0, credit: 0 }, // EMPLOYEE_COSTS
  { code: "21112107", debit: 188_000_000.0, credit: 0 }, // EMPLOYEE_COSTS
  { code: "22001101", debit: 79_200_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22003102", debit: 104_500_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22010105", debit: 231_000_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "22018107", debit: 142_300_000.0, credit: 0 }, // USE_OF_GOODS_AND_SERVICES
  { code: "26312106", debit: 585_000_000.0, credit: 0 }, // GRANTS_TRANSFERS_EXPENSE
  { code: "23110101", debit: 96_000_000.0, credit: 0 }, // DEPRECIATION_AMORTISATION
  { code: "23120102", debit: 288_000_000.0, credit: 0 }, // DEPRECIATION_AMORTISATION
  { code: "23120103", debit: 426_000_000.0, credit: 0 }, // DEPRECIATION_AMORTISATION
  { code: "23130102", debit: 73_500_000.0, credit: 0 }, // DEPRECIATION_AMORTISATION
  { code: "61112102", debit: 9_600_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61112103", debit: 14_200_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61113101", debit: 5_300_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61121101", debit: 2_400_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_OPENING
  { code: "61462102", debit: 0, credit: 2_592_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "61462103", debit: 0, credit: 3_834_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "61463101", debit: 0, credit: 1_431_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "61465101", debit: 0, credit: 840_000_000.0 }, // PPE_ACCUMULATED_DEPRECIATION_CONTRA
  { code: "31112102", debit: 225_000_000.0, credit: 0 }, // PROPERTY_PLANT_EQUIPMENT_ADDITIONS
  { code: "31710109", debit: 1_310_000_000.0, credit: 0 }, // WORK_IN_PROGRESS
  { code: "31221101", debit: 58_000_000.0, credit: 0 }, // INVENTORIES
  { code: "32171120", debit: 31_200_000.0, credit: 0 }, // RECEIVABLES
  { code: "32171108", debit: 184_000_000.0, credit: 0 }, // RECEIVABLES
  { code: "32173113", debit: 0, credit: 21_000_000.0 }, // RECEIVABLES_ECL_PROVISION_CONTRA
  { code: "62123131", debit: 1_495_000_000.0, credit: 0 }, // CASH_AND_CASH_EQUIVALENTS
  { code: "62123133", debit: 612_000_000.0, credit: 0 }, // CASH_AND_CASH_EQUIVALENTS
  { code: "62123115", debit: 254_000_000.0, credit: 0 }, // CASH_AND_CASH_EQUIVALENTS
  { code: "33181102", debit: 0, credit: 598_000_000.0 }, // PAYABLES_AND_ACCRUALS
  { code: "33181103", debit: 0, credit: 81_500_000.0 }, // PAYABLES_AND_ACCRUALS
  { code: "33181109", debit: 0, credit: 254_000_000.0 }, // DEPOSITS_HELD
  { code: "33182107", debit: 0, credit: 18_730_000.0 }, // WITHHOLDING_TAX_PAYABLE
  { code: "33191110", debit: 0, credit: 905_000_000.0 }, // DEFERRED_REVENUE_INCOME
  { code: "63333501", debit: 0, credit: 2_500_000_000.0 }, // RESERVES
  { code: "63293101", debit: 0, credit: 18_273_220_000.0 }, // ACCUMULATED_SURPLUS_DEFICIT
];
