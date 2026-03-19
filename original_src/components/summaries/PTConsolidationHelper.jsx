import React, { useState } from "react";
import { Zap, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";

// Detect if a visit is physical therapy (strict matching on practice_setting only)
function isPTVisit(visit) {
  const practice = (visit.practice_setting || '').toLowerCase().trim();
  
  // Only match if practice_setting explicitly contains PT-related keywords
  // This prevents matching general medical offices
  const ptPatterns = [
    /^physical therapy/i,
    /^pt\s/i,
    /\bphysical therapy\b/i,
    /\bphysiotherapy\b/i,
    /^rehabilitation/i,
    /^rehab\b/i
  ];
  
  return ptPatterns.some(pattern => pattern.test(practice));
}

export default function PTConsolidationHelper({ visits, onConsolidate }) {
  const [showConfirm, setShowConfirm] = useState(false);
  
  const ptVisits = visits.filter(isPTVisit);
  
  if (ptVisits.length <= 1) {
    return null;
  }

  const handleConsolidate = () => {
    const sorted = [...ptVisits].sort((a, b) => {
      if (!a.visit_date) return 1;
      if (!b.visit_date) return -1;
      return new Date(a.visit_date) - new Date(b.visit_date);
    });

    const firstVisit = sorted[0];
    const lastVisit = sorted[sorted.length - 1];
    
    // Use most common practice_setting as the facility name
    const facilityMap = {};
    sorted.forEach(v => {
      if (v.practice_setting) {
        facilityMap[v.practice_setting] = (facilityMap[v.practice_setting] || 0) + 1;
      }
    });
    const facility = Object.keys(facilityMap).length > 0
      ? Object.keys(facilityMap).reduce((a, b) => facilityMap[a] > facilityMap[b] ? a : b)
      : 'Physical Therapy';

    onConsolidate({
      firstVisit,
      lastVisit,
      facility,
      totalSessions: sorted.length,
    }, ptVisits);
    setShowConfirm(false);
  };

  return (
    <>
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-blue-600" />
            <span className="font-semibold text-blue-900">Consolidate Physical Therapy Visits</span>
          </div>
          <p className="text-sm text-blue-800">
            Found {ptVisits.length} PT visits. Consolidate into one summary paragraph?
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowConfirm(true)}
          className="ml-4 flex-shrink-0"
        >
          Consolidate
        </Button>
      </div>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Consolidate PT Visits?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>This will replace {ptVisits.length} physical therapy visits with two entries: an <strong>Initial Visit</strong> and a <strong>Final Visit ({ptVisits.length} sessions attended)</strong>.</p>
              <div className="bg-slate-50 p-3 rounded text-sm text-slate-700 max-h-40 overflow-y-auto">
                <strong>PT Visits to consolidate:</strong>
                <ul className="mt-2 space-y-1">
                  {ptVisits.map((v, i) => (
                    <li key={i} className="text-xs">
                      {v.visit_date && new Date(v.visit_date).toLocaleDateString()} - {v.practice_setting || 'PT'}
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-3">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConsolidate}
              className="bg-blue-600 hover:bg-blue-700"
            >
              Consolidate
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}