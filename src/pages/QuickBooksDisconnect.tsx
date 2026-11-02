import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
/** Intuit's navigation is informational, not a signed webhook. No realm parameter, token, or mutation is consumed here. */
export default function QuickBooksDisconnect() {
  return <main className="mx-auto max-w-xl space-y-5 px-6 py-16 text-foreground">
    <h1 className="text-2xl font-semibold">Disconnect QuickBooks</h1>
    <p>Your saved trial balances remain unchanged. Sign in to CFOClose, open the connected workspace and confirm Disconnect QuickBooks.</p>
    <p className="text-sm text-muted-foreground">Visiting this page does not remove anyone’s connection. If you disconnected in QuickBooks, new access may already have ended there.</p>
    <Button asChild><Link to="/workspace">Open CFOClose</Link></Button>
  </main>;
}