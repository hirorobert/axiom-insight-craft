import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PlanCatalogue } from "@/components/commercial/PlanCatalogue";
import { usePublicPlanPrices } from "@/lib/commercial/checkoutClient";
export default function Pricing() {
  const prices = usePublicPlanPrices();
  return <div className="flex min-h-screen flex-col bg-background"><Header /><main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-28 sm:px-5"><p className="text-xs uppercase text-muted-foreground">CFOClose · Pricing</p><h1 className="mt-3 text-3xl font-semibold text-foreground">Plans that grow with your portfolio.</h1><p className="mt-3 mb-10 max-w-2xl text-sm text-muted-foreground">Compare our plans by entities and named users. Every plan is a 12-month term and does not renew automatically.</p><PlanCatalogue prices={prices} /></main><Footer /></div>;
}
