import React, { useState, useEffect } from "react";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogDescription,
  DialogFooter 
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { 
  Upload, 
  Library, 
  Copy, 
  FileCheck, 
  ArrowRight, 
  ArrowLeft,
  CheckCircle,
  FileText,
  X
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const tutorialSteps = [
  {
    title: "Welcome to ChartReview Pro",
    description: "Your intelligent document management system for medical and legal documents. Let's take a quick tour!",
    icon: FileText,
    color: "from-blue-600 to-cyan-600"
  },
  {
    title: "Upload Documents",
    description: "Drag and drop your PDF documents or click to browse. The system automatically extracts text and metadata using AI, and organizes them into folders for easy management.",
    icon: Upload,
    color: "from-green-600 to-emerald-600",
    features: [
      "Automatic text extraction",
      "AI-powered metadata detection",
      "Folder organization",
      "Duplicate detection"
    ]
  },
  {
    title: "Document Library",
    description: "Browse, search, and organize all your documents in one place. View by date or folder, and quickly find what you need with powerful search and filters.",
    icon: Library,
    color: "from-purple-600 to-pink-600",
    features: [
      "Search and filter documents",
      "Organize by folders",
      "Preview documents",
      "Bulk actions"
    ]
  },
  {
    title: "Duplicate Detection",
    description: "Automatically identify duplicate documents and pages. Review side-by-side comparisons and remove duplicates with one click to keep your library clean.",
    icon: Copy,
    color: "from-orange-600 to-red-600",
    features: [
      "Automatic duplicate detection",
      "Side-by-side comparison",
      "Remove duplicate pages",
      "Keep originals or deduplicated versions"
    ]
  },
  {
    title: "Medical Summaries",
    description: "Generate comprehensive AI-powered medical summaries from your documents. Select multiple documents, and get structured visit summaries ready to export.",
    icon: FileCheck,
    color: "from-indigo-600 to-purple-600",
    features: [
      "AI-generated summaries",
      "Structured visit data",
      "Combine multiple documents",
      "Export to Word"
    ]
  }
];

export default function Tutorial({ onClose }) {
  const [currentStep, setCurrentStep] = useState(0);
  const step = tutorialSteps[currentStep];
  const Icon = step.icon;
  const isLastStep = currentStep === tutorialSteps.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      onClose();
    } else {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    setCurrentStep(Math.max(0, currentStep - 1));
  };

  const handleSkip = () => {
    onClose();
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-2xl">Getting Started</DialogTitle>
            <Button variant="ghost" size="sm" onClick={handleSkip}>
              <X className="w-4 h-4" />
            </Button>
          </div>
          <DialogDescription>
            Step {currentStep + 1} of {tutorialSteps.length}
          </DialogDescription>
        </DialogHeader>

        <div className="py-6">
          <Card className={`bg-gradient-to-br ${step.color} border-0 shadow-lg`}>
            <CardContent className="p-8 text-center text-white">
              <div className="w-20 h-20 mx-auto mb-4 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm">
                <Icon className="w-10 h-10" />
              </div>
              <h3 className="text-2xl font-bold mb-3">{step.title}</h3>
              <p className="text-white/90 text-lg">{step.description}</p>
            </CardContent>
          </Card>

          {step.features && (
            <div className="mt-6 space-y-3">
              {step.features.map((feature, index) => (
                <div key={index} className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  </div>
                  <p className="text-slate-700">{feature}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between items-center border-t pt-4">
          <div className="flex gap-1">
            {tutorialSteps.map((_, index) => (
              <div
                key={index}
                className={`w-2 h-2 rounded-full transition-all ${
                  index === currentStep 
                    ? 'bg-blue-600 w-6' 
                    : index < currentStep 
                    ? 'bg-green-600' 
                    : 'bg-slate-300'
                }`}
              />
            ))}
          </div>

          <div className="flex gap-2">
            {currentStep > 0 && (
              <Button variant="outline" onClick={handleBack}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            )}
            <Button 
              onClick={handleNext}
              className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
            >
              {isLastStep ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Get Started
                </>
              ) : (
                <>
                  Next
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}