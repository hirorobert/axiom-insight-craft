import { Link } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PlanCatalogue } from "@/components/commercial/PlanCatalogue";
import { Button } from "@/components/ui/button";

export default function Plans() {
  return <div className="flex min-h-screen flex-col bg-background"><Header /><main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-16 pt-28"><p className="text-xs uppercase text-muted-foreground">CFOClose · Plans</p><h1 className="mt-3 text-3xl font-semibold text-foreground">Choose your plan</h1><p className="mt-3 mb-10 max-w-2xl text-sm text-muted-foreground">Review the plan that fits your work. Online payment is not available yet; choosing a plan does not activate it.</p><PlanCatalogue /><div className="mt-10"><Button asChild variant="outline"><Link to="/dashboard">Back to your workspaces</Link></Button></div></main><Footer /></div>;
}
