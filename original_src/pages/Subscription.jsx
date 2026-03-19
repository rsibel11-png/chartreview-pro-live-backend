import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { 
  Check, 
  Loader2, 
  FileText, 
  TrendingUp, 
  Calendar,
  CreditCard,
  AlertCircle,
  Sparkles,
  Gift
} from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

// Tiered pricing: ≤100 @ $0.60, 101-1000 @ $0.55, 1001-5000 @ $0.50, 5001-10000 @ $0.45, 10001+ @ $0.40
const PAGE_PACKS = [
  {
    id: 'pack-100',
    name: '100 Pages',
    price: '$60',
    priceId: 'price_1T8QMOEsaa7Ny8xAH317oZmj',
    pages: 100,
    pricePerPage: '$0.60',
    tier: 'Tier 1',
    tierLabel: '≤ 100 pages',
  },
  {
    id: 'pack-500',
    name: '500 Pages',
    price: '$275',
    priceId: 'price_1T8QMOEsaa7Ny8xAhP847sqU',
    pages: 500,
    pricePerPage: '$0.55',
    tier: 'Tier 2',
    tierLabel: '101 – 1,000 pages',
    popular: true,
  },
  {
    id: 'pack-1000',
    name: '1,000 Pages',
    price: '$550',
    priceId: 'price_1T8QMOEsaa7Ny8xAO5pXSg8K',
    pages: 1000,
    pricePerPage: '$0.55',
    tier: 'Tier 2',
    tierLabel: '101 – 1,000 pages',
  },
  {
    id: 'pack-2500',
    name: '2,500 Pages',
    price: '$1,250',
    priceId: 'price_1T8QMOEsaa7Ny8xAVoCMWKOi',
    pages: 2500,
    pricePerPage: '$0.50',
    tier: 'Tier 3',
    tierLabel: '1,001 – 5,000 pages',
  },
  {
    id: 'pack-5000',
    name: '5,000 Pages',
    price: '$2,500',
    priceId: 'price_1T8QMOEsaa7Ny8xAiDxYxDUn',
    pages: 5000,
    pricePerPage: '$0.50',
    tier: 'Tier 3',
    tierLabel: '1,001 – 5,000 pages',
  },
  {
    id: 'pack-7500',
    name: '7,500 Pages',
    price: '$3,375',
    priceId: 'price_1T8QMOEsaa7Ny8xAytjmjNdI',
    pages: 7500,
    pricePerPage: '$0.45',
    tier: 'Tier 4',
    tierLabel: '5,001 – 10,000 pages',
  },
  {
    id: 'pack-10000',
    name: '10,000 Pages',
    price: '$4,500',
    priceId: 'price_1T8QMOEsaa7Ny8xAUMm0vG0g',
    pages: 10000,
    pricePerPage: '$0.45',
    tier: 'Tier 4',
    tierLabel: '5,001 – 10,000 pages',
  },
  {
    id: 'pack-25000',
    name: '25,000 Pages',
    price: '$10,000',
    priceId: 'price_1T8QMOEsaa7Ny8xAEPqX5crB',
    pages: 25000,
    pricePerPage: '$0.40',
    tier: 'Tier 5',
    tierLabel: '10,001+ pages',
  },
];

export default function Subscription() {
  const [loading, setLoading] = useState(null);

  const { data: user, isLoading, refetch } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => base44.auth.me(),
  });

  const { data: documents = [] } = useQuery({
    queryKey: ['documents'],
    queryFn: () => base44.entities.Document.list(),
    initialData: [],
  });

  // Initialize trial for new users
  useEffect(() => {
    if (user && !user.trial_ends_at) {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + 7);
      
      const freeReset = new Date();
      freeReset.setMonth(freeReset.getMonth() + 1);
      
      base44.auth.updateMe({
        trial_ends_at: trialEnd.toISOString(),
        trial_bonus_pages: 1000,
        free_pages_remaining: 100,
        free_pages_reset_date: freeReset.toISOString()
      }).then(() => refetch());
    }
  }, [user]);

  const handleCheckout = async (priceId, pageCredits) => {
    if (window.self !== window.top) {
      alert('Checkout is only available from the published app, not from the preview iframe. Please open your published app to complete the purchase.');
      return;
    }

    setLoading(priceId);
    try {
      const response = await base44.functions.invoke('create-checkout', { priceId, pageCredits });
      window.location.href = response.data.url;
    } catch (error) {
      console.error('Checkout error:', error);
      alert('Failed to start checkout. Please try again.');
      setLoading(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const trialBonus = user?.trial_bonus_pages || 0;
  const freePages = user?.free_pages_remaining || 0;
  const credits = user?.page_credits || 0;
  const totalAvailable = trialBonus + freePages + credits;
  
  const trialEnds = user?.trial_ends_at ? new Date(user.trial_ends_at) : null;
  const trialActive = trialEnds && new Date() < trialEnds;
  const trialDaysLeft = trialActive ? Math.ceil((trialEnds - new Date()) / (1000 * 60 * 60 * 24)) : 0;

  const freeResetDate = user?.free_pages_reset_date ? new Date(user.free_pages_reset_date) : null;
  const daysUntilReset = freeResetDate ? Math.ceil((freeResetDate - new Date()) / (1000 * 60 * 60 * 24)) : null;

  const totalProcessed = user?.total_pages_processed || 0;

  return (
    <div className="p-6 md:p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Page Credits & Usage</h1>
        <p className="text-slate-600 mt-2">100 free pages per month + purchased credits that never expire</p>
      </div>

      {/* Trial Alert */}
      {trialActive && trialBonus > 0 && (
        <Alert className="border-blue-200 bg-blue-50">
          <Sparkles className="h-4 w-4 text-blue-600" />
          <AlertTitle className="text-blue-900">🎉 Welcome Bonus Active!</AlertTitle>
          <AlertDescription className="text-blue-700">
            You have {trialBonus} bonus pages remaining for {trialDaysLeft} more day{trialDaysLeft !== 1 ? 's' : ''}. Trial ends {trialEnds.toLocaleDateString()}.
          </AlertDescription>
        </Alert>
      )}

      {/* Low Credits Alert */}
      {totalAvailable <= 250 && (
        <Alert variant="default" className="border-amber-200 bg-amber-50">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-900">Low Page Credits</AlertTitle>
          <AlertDescription className="text-amber-700">
            You have only {totalAvailable} pages remaining. Purchase more credits to continue uploading documents.
          </AlertDescription>
        </Alert>
      )}

      {/* Current Balance */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="shadow-lg border-2 border-blue-500">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileText className="w-5 h-5 text-blue-600" />
              Total Available
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold text-blue-600">{totalAvailable}</div>
            <p className="text-sm text-slate-500 mt-1">pages ready to use</p>
          </CardContent>
        </Card>

        {trialActive && (
          <Card className="shadow-lg bg-gradient-to-br from-purple-50 to-blue-50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Gift className="w-5 h-5 text-purple-600" />
                Trial Bonus
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold text-purple-600">{trialBonus}</div>
              <p className="text-sm text-slate-500 mt-1">{trialDaysLeft} days left</p>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-lg bg-gradient-to-br from-green-50 to-emerald-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Calendar className="w-5 h-5 text-green-600" />
              Free Monthly
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold text-green-600">{freePages}</div>
            <p className="text-sm text-slate-500 mt-1">
              {daysUntilReset ? `Resets in ${daysUntilReset} days` : 'of 100 pages'}
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-lg bg-gradient-to-br from-cyan-50 to-blue-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CreditCard className="w-5 h-5 text-cyan-600" />
              Purchased Credits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold text-cyan-600">{credits}</div>
            <p className="text-sm text-slate-500 mt-1">never expire</p>
          </CardContent>
        </Card>
      </div>

      {/* How It Works */}
      <Card className="shadow-lg border-blue-200">
        <CardHeader>
          <CardTitle className="text-xl">How Page Credits Work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                <span className="text-purple-600 font-bold">1</span>
              </div>
              <div>
                <h4 className="font-semibold text-slate-900 mb-1">Trial Bonus (7 days)</h4>
                <p className="text-sm text-slate-600">New users get 1,000 bonus pages for the first week</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                <span className="text-green-600 font-bold">2</span>
              </div>
              <div>
                <h4 className="font-semibold text-slate-900 mb-1">Free Monthly Pages</h4>
                <p className="text-sm text-slate-600">Get 100 free pages every month, automatically resets</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-cyan-100 flex items-center justify-center flex-shrink-0">
                <span className="text-cyan-600 font-bold">3</span>
              </div>
              <div>
                <h4 className="font-semibold text-slate-900 mb-1">Purchase Page Packs</h4>
                <p className="text-sm text-slate-600">Buy credits anytime - they never expire and roll over</p>
              </div>
            </div>
          </div>
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
            <p className="text-sm text-slate-700">
              <strong>Usage Order:</strong> Pages are deducted in this order: Trial Bonus → Free Monthly → Purchased Credits
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Pricing Tiers Summary */}
      <Card className="shadow-lg border-blue-200">
        <CardHeader>
          <CardTitle className="text-xl">Volume Pricing Tiers</CardTitle>
          <CardDescription>The more pages you buy, the lower the per-page cost</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-2 pr-4 font-semibold text-slate-700">Tier</th>
                  <th className="text-left py-2 pr-4 font-semibold text-slate-700">Page Range</th>
                  <th className="text-left py-2 font-semibold text-slate-700">Price per Page</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr><td className="py-2 pr-4 text-slate-600">Tier 1</td><td className="py-2 pr-4 text-slate-600">Up to 100 pages</td><td className="py-2 font-semibold text-slate-900">$0.60</td></tr>
                <tr><td className="py-2 pr-4 text-slate-600">Tier 2</td><td className="py-2 pr-4 text-slate-600">101 – 1,000 pages</td><td className="py-2 font-semibold text-slate-900">$0.55</td></tr>
                <tr><td className="py-2 pr-4 text-slate-600">Tier 3</td><td className="py-2 pr-4 text-slate-600">1,001 – 5,000 pages</td><td className="py-2 font-semibold text-slate-900">$0.50</td></tr>
                <tr><td className="py-2 pr-4 text-slate-600">Tier 4</td><td className="py-2 pr-4 text-slate-600">5,001 – 10,000 pages</td><td className="py-2 font-semibold text-slate-900">$0.45</td></tr>
                <tr><td className="py-2 pr-4 text-slate-600">Tier 5</td><td className="py-2 pr-4 text-slate-600">10,001+ pages</td><td className="py-2 font-semibold text-green-700">$0.40 ✦ Best Value</td></tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Page Packs */}
      <div>
        <h2 className="text-2xl font-bold text-slate-900 mb-6">Buy Page Packs</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {PAGE_PACKS.map((pack) => (
            <Card 
              key={pack.id}
              className={`shadow-lg relative hover:shadow-xl transition-shadow ${
                pack.popular ? 'border-2 border-blue-500' : ''
              }`}
            >
              {pack.popular && (
                <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                  <Badge className="bg-blue-600">Most Popular</Badge>
                </div>
              )}
              
              <CardHeader>
                <CardTitle className="text-xl">{pack.name}</CardTitle>
                <CardDescription>
                  <span className="font-semibold text-blue-700">{pack.pricePerPage}/page</span>
                  <span className="ml-2 text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{pack.tier}</span>
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                <div>
                  <div className="text-4xl font-bold text-slate-900">{pack.price}</div>
                  <p className="text-sm text-slate-500">one-time purchase</p>
                  <p className="text-xs text-green-600 mt-1">Credits never expire</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <span className="text-sm text-slate-700">{pack.pages.toLocaleString()} page credits</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <span className="text-sm text-slate-700">Never expires</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <span className="text-sm text-slate-700">Instant activation</span>
                  </div>
                </div>

                <Button 
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  onClick={() => handleCheckout(pack.priceId, pack.pages)}
                  disabled={loading === pack.priceId}
                >
                  {loading === pack.priceId ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    'Purchase Now'
                  )}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Statistics */}
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-blue-600" />
            Account Statistics
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-slate-500 mb-1">Total Documents</p>
              <p className="text-2xl font-bold text-slate-900">{documents.length}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Lifetime Pages Processed</p>
              <p className="text-2xl font-bold text-slate-900">{totalProcessed.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Available Credits</p>
              <p className="text-2xl font-bold text-slate-900">{totalAvailable}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Account Created</p>
              <p className="text-2xl font-bold text-slate-900">
                {new Date(user?.created_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}