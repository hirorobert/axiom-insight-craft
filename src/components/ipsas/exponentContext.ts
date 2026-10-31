import { createContext } from "react";

/**
 * The number of decimal places of the denomination the SERVER confirmed for this period (independent review of #229, finding 4). An amount field outside
 * a known denomination does not guess one: it is disabled and says why.
 */
export const ExponentContext = createContext<number | null>(null);
