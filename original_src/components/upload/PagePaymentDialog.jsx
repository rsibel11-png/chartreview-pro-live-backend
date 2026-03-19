import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CreditCard, FileText, CheckCircle, AlertCircle, Info } from "lucide-react";

// Tiered pricing logic
function getPricePerPage(pages) {
  if (pages <= 100) return 0.60;
  if (pages <= 1000) return 0.55;
  if (pages <= 5000) return 0.50;
  if (pages <= 10000) return 0.45;
  return 0.40;
}

function getTierLabel(pages) {
  if (pages <= 100) return "Tier 1 (≤100 pages)";
  if (pages <= 1000) return "Tier 2 (101–1,000 pages)";
  if (pages <= 5000) return "Tier 3 (1,001–5,000 pages)";
  if (pages <= 10000) return "Tier 4 (5,001–10,000 pages)";
  return "Tier 5 (10,001+ pages)";
}

function getTierColor(pages) {
  if (pages <= 100) return "bg-slate-100 text-slate-700";
  if (pages <= 1000) return "bg-blue-100 text-blue-700";
  if (pages <= 5000) return "bg-cyan-100 text-cyan-700";
  if (pages <= 10000) return "bg-green-100 text-green-700";
  return "bg-emerald-100 text-emerald-700";
}

const BUNDLE_SIZES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000];

function getBundleOptions(neededPages) {
  return BUNDLE_SIZES.filter(size => size > neededPages).slice(0, 4);
}

export default function PagePaymentDialog({ open, onClose, estimatedPages, onProceed }) {
  const [paymentMode, setPaymentMode] = useState(null); // 'credits' | 'stripe'
  const [stripeLoading, setStripeLoading] = useState(false);
  const [sessionPaid, setSessionPaid] = useState(false);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [selectedBundle, setSelectedBundle] = useState(null); // null = exact amount

  const { data: user, refetch: refetchUser } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const pages = estimatedPages || 0;
  const pricePerPage = getPricePerPage(pages);
  const totalCost = Math.round(pages * pricePerPage * 100); // cents
  const totalCostDisplay = `$${(totalCost / 100).toFixed(2)}`;

  const bundleOptions = getBundleOptions(pages);
  const payPages = selectedBundle || pages;
  const payPricePerPage = getPricePerPage(payPages);
  const payCost = selectedBundle
    ? Math.round(selectedBundle * payPricePerPage * 100)
    : totalCost;
  const payCostDisplay = `$${(payCost / 100).toFixed(2)}`;

  const trialEnds = user?.trial_ends_at ? new Date(user.trial_ends_at) : null;
  const trialActive = trialEnds && new Date() < trialEnds;
  const trialBonus = trialActive ? (user?.trial_bonus_pages || 0) : 0;
  const freePages = user?.free_pages_remaining || 0;
  const purchasedCredits = user?.page_credits || 0;
  const totalCredits = trialBonus + freePages + purchasedCredits;
  const hasEnoughCredits = user?.role === 'admin' || totalCredits >= pages;

  // Check if returning from a Stripe payment
  useEffect(() => {
    if (!open) return;
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('upload_session_id');
    if (sessionId) {
      setCheckingPayment(true);
      // Remove from URL
      const newUrl = window.location.pathname;
      window.history.replaceState({}, '', newUrl);
      // Refetch user to see updated credits
      refetchUser().then(() => {
        setCheckingPayment(false);
        setSessionPaid(true);
        setPaymentMode('stripe_done');
      });
    }
  }, [open]);

  const handleUseCredits = () => {
    setPaymentMode('credits');
    onProceed('credits');
  };

  const handleStripeCheckout = async () => {
    if (window.self !== window.top) {
      alert('Checkout is only available from the published app, not from the preview iframe.');
      return;
    }
    setStripeLoading(true);
    try {
      const response = await base44.functions.invoke('createCustomCheckout', {
        pages: payPages,
        amountCents: payCost,
        returnPath: window.location.pathname + '?upload_session_id=pending'
      });
      window.location.href = response.data.url;
    } catch (err) {
      console.error('Checkout error:', err);
      alert('Failed to start checkout. Please try again.');
      setStripeLoading(false);
    }
  };

  if (checkingPayment) {
    return (
      <Dialog open={open}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
            <p className="text-slate-700 font-medium">Verifying payment...</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (sessionPaid) {
    return (
      <Dialog open={open}>
        <DialogContent className="max-w-md">
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <CheckCircle className="w-12 h-12 text-green-600" />
            <h3 className="text-xl font-bold text-slate-900">Payment Confirmed!</h3>
            <p className="text-slate-600">Your credits have been added. Click below to proceed with your upload.</p>
            <Button className="bg-green-600 hover:bg-green-700 w-full" onClick={() => onProceed('stripe_paid')}>
              Start Upload
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <FileText className="w-5 h-5 text-blue-600" />
            Upload Payment Required
          </DialogTitle>
          <DialogDescription>
            Review the page count and cost before processing your documents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Summary */}
          <div className="bg-slate-50 rounded-xl border border-slate-200 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-slate-600 font-medium">Pages to process</span>
              <span className="text-2xl font-bold text-slate-900">{pages.toLocaleString()}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600 font-medium">Pricing tier</span>
              <Badge className={getTierColor(pages)}>{getTierLabel(pages)}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-600 font-medium">Rate</span>
              <span className="font-semibold text-slate-800">${pricePerPage.toFixed(2)} / page</span>
            </div>
            <div className="border-t border-slate-200 pt-3 flex items-center justify-between">
              <span className="text-slate-900 font-bold text-lg">Total</span>
              <span className="text-2xl font-bold text-blue-700">{totalCostDisplay}</span>
            </div>
          </div>

          {/* Current Credits */}
          <div className="bg-blue-50 rounded-lg border border-blue-200 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Info className="w-4 h-4 text-blue-600" />
              <span className="text-sm font-semibold text-blue-900">Your Available Credits</span>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center text-sm">
              {trialActive && trialBonus > 0 && (
                <div>
                  <div className="font-bold text-purple-700">{trialBonus}</div>
                  <div className="text-slate-500 text-xs">Trial Bonus</div>
                </div>
              )}
              <div>
                <div className="font-bold text-green-700">{freePages}</div>
                <div className="text-slate-500 text-xs">Free Monthly</div>
              </div>
              <div>
                <div className="font-bold text-cyan-700">{purchasedCredits}</div>
                <div className="text-slate-500 text-xs">Purchased</div>
              </div>
              <div className={trialActive && trialBonus > 0 ? "col-span-3" : "col-span-1"}>
                <div className={`font-bold text-lg ${hasEnoughCredits ? 'text-green-700' : 'text-red-600'}`}>
                  {totalCredits}
                </div>
                <div className="text-slate-500 text-xs">Total Available</div>
              </div>
            </div>
          </div>

          {hasEnoughCredits && user?.role !== 'admin' && (
            <Alert className="border-green-200 bg-green-50">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                You have enough credits to cover this upload. {pages} credits will be deducted from your account.
              </AlertDescription>
            </Alert>
          )}

          {!hasEnoughCredits && (
            <Alert className="border-amber-200 bg-amber-50">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-800">
                You need {pages - totalCredits} more credits. Pay with card to add exactly the right amount.
              </AlertDescription>
            </Alert>
          )}

          {/* Bundle Options */}
          {bundleOptions.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-700">Buy a larger bundle & save:</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSelectedBundle(null)}
                  className={`rounded-lg border p-3 text-left transition-all ${
                    selectedBundle === null
                      ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400'
                      : 'border-slate-200 bg-white hover:border-blue-300'
                  }`}
                >
                  <div className="font-semibold text-slate-900 text-sm">{pages.toLocaleString()} pages</div>
                  <div className="text-xs text-slate-500">Exact amount</div>
                  <div className="text-sm font-bold text-blue-700 mt-1">{totalCostDisplay}</div>
                </button>
                {bundleOptions.map(size => {
                  const rate = getPricePerPage(size);
                  const cost = Math.round(size * rate * 100);
                  const savings = (pricePerPage - rate).toFixed(2);
                  return (
                    <button
                      key={size}
                      onClick={() => setSelectedBundle(size)}
                      className={`rounded-lg border p-3 text-left transition-all ${
                        selectedBundle === size
                          ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400'
                          : 'border-slate-200 bg-white hover:border-blue-300'
                      }`}
                    >
                      <div className="font-semibold text-slate-900 text-sm">{size.toLocaleString()} pages</div>
                      <div className="text-xs text-green-600 font-medium">
                        {savings > 0 ? `Save $${savings}/pg` : getTierLabel(size).split('(')[0].trim()}
                      </div>
                      <div className="text-sm font-bold text-blue-700 mt-1">${(cost / 100).toFixed(2)}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-3">
            {hasEnoughCredits ? (
              <Button
                className="w-full bg-blue-600 hover:bg-blue-700 h-12 text-base"
                onClick={handleUseCredits}
              >
                <CheckCircle className="w-5 h-5 mr-2" />
                Use My Credits &amp; Start Upload
              </Button>
            ) : null}

            <Button
              variant={hasEnoughCredits ? "outline" : "default"}
              className={`w-full h-12 text-base ${!hasEnoughCredits ? 'bg-blue-600 hover:bg-blue-700' : ''}`}
              onClick={handleStripeCheckout}
              disabled={stripeLoading}
            >
              {stripeLoading ? (
                <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Redirecting to payment...</>
              ) : (
                <><CreditCard className="w-5 h-5 mr-2" /> Pay {payCostDisplay}{selectedBundle ? ` for ${selectedBundle.toLocaleString()} pages` : ''} with Card</>
              )}
            </Button>

            <Button variant="ghost" className="w-full text-slate-500" onClick={onClose}>
              Cancel Upload
            </Button>
          </div>

          <p className="text-xs text-slate-400 text-center">
            * Page count is an estimate based on document analysis. Final deduction matches actual pages processed.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}