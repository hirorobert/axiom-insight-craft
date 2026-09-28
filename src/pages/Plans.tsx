import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PlanCatalogue } from "@/components/commercial/PlanCatalogue";
import { NO_CHECKOUT_NOTICE } from "@/lib/commercial/pricingCatalogue";

export default function Plans() {
  return <div className="flex min-h-screen flex-col bg-background"><Header /><main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-16 pt-28"><p className="text-xs uppercase text-muted-foreground">CFOClose · Plans</p><h1 className="mt-3 text-3xl font-semibold text-foreground">Choose your plan</h1><p className="mt-3 mb-10 max-w-2xl text-sm text-muted-foreground">Review the plan that fits your work. {NO_CHECKOUT_NOTICE}</p><PlanCatalogue /></main><Footer /></div>;
}
