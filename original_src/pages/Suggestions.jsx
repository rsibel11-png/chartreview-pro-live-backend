import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  MessageSquarePlus, 
  Send, 
  Lightbulb, 
  CheckCircle, 
  Clock, 
  X,
  AlertCircle,
  Calendar
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { format } from "date-fns";

export default function SuggestionsPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    category: "feature_request",
    priority: "medium"
  });

  const { data: suggestions = [], isLoading } = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => base44.entities.Suggestion.list('-created_date'),
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Suggestion.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] });
      setFormData({ title: "", description: "", category: "feature_request", priority: "medium" });
      setShowForm(false);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    createMutation.mutate(formData);
  };

  const categoryIcons = {
    bug_report: <AlertCircle className="w-4 h-4" />,
    feature_request: <Lightbulb className="w-4 h-4" />,
    improvement: <MessageSquarePlus className="w-4 h-4" />,
    other: <MessageSquarePlus className="w-4 h-4" />
  };

  const statusColors = {
    submitted: "bg-blue-100 text-blue-800",
    under_review: "bg-purple-100 text-purple-800",
    planned: "bg-yellow-100 text-yellow-800",
    completed: "bg-green-100 text-green-800",
    declined: "bg-gray-100 text-gray-800"
  };

  const categoryColors = {
    bug_report: "bg-red-100 text-red-800",
    feature_request: "bg-blue-100 text-blue-800",
    improvement: "bg-green-100 text-green-800",
    other: "bg-gray-100 text-gray-800"
  };

  const priorityColors = {
    low: "bg-gray-100 text-gray-800",
    medium: "bg-yellow-100 text-yellow-800",
    high: "bg-orange-100 text-orange-800"
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Suggestions & Feedback</h1>
            <p className="text-slate-600 mt-1">Request new features or report issues</p>
          </div>
          <Button 
            onClick={() => setShowForm(!showForm)}
            className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
          >
            <MessageSquarePlus className="w-4 h-4 mr-2" />
            New Suggestion
          </Button>
        </div>

        {/* Info Alert */}
        <Alert className="bg-blue-50 border-blue-200">
          <Lightbulb className="w-4 h-4 text-blue-600" />
          <AlertDescription className="text-blue-900">
            Share your ideas to help improve the app! We review all suggestions and appreciate your feedback.
          </AlertDescription>
        </Alert>

        {/* Suggestion Form */}
        {showForm && (
          <Card className="shadow-lg border-2 border-blue-200">
            <CardHeader>
              <CardTitle>Submit a Suggestion</CardTitle>
              <CardDescription>Tell us about your idea or report an issue</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-700 mb-1 block">
                    Title *
                  </label>
                  <Input
                    placeholder="Brief summary of your suggestion"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    required
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-slate-700 mb-1 block">
                    Description *
                  </label>
                  <Textarea
                    placeholder="Describe your suggestion in detail..."
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="h-32"
                    required
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-slate-700 mb-1 block">
                      Category
                    </label>
                    <Select 
                      value={formData.category} 
                      onValueChange={(value) => setFormData({ ...formData, category: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bug_report">Bug Report</SelectItem>
                        <SelectItem value="feature_request">Feature Request</SelectItem>
                        <SelectItem value="improvement">Improvement</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-slate-700 mb-1 block">
                      Priority
                    </label>
                    <Select 
                      value={formData.priority} 
                      onValueChange={(value) => setFormData({ ...formData, priority: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={() => setShowForm(false)}
                  >
                    <X className="w-4 h-4 mr-2" />
                    Cancel
                  </Button>
                  <Button 
                    type="submit" 
                    disabled={createMutation.isPending}
                    className="bg-gradient-to-r from-blue-600 to-cyan-600"
                  >
                    <Send className="w-4 h-4 mr-2" />
                    {createMutation.isPending ? 'Submitting...' : 'Submit Suggestion'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Suggestions List */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-slate-900">Your Suggestions</h2>
          
          {isLoading ? (
            <Card>
              <CardContent className="p-8 text-center text-slate-500">
                <Clock className="w-8 h-8 mx-auto mb-2 animate-spin" />
                Loading suggestions...
              </CardContent>
            </Card>
          ) : suggestions.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-slate-500">
                <MessageSquarePlus className="w-12 h-12 mx-auto mb-3 text-slate-400" />
                <p className="text-lg font-medium">No suggestions yet</p>
                <p className="text-sm mt-1">Click "New Suggestion" to submit your first idea!</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {suggestions.map((suggestion) => (
                <Card key={suggestion.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-start gap-3 mb-3">
                          <div className="mt-1">
                            {categoryIcons[suggestion.category]}
                          </div>
                          <div className="flex-1">
                            <h3 className="font-semibold text-slate-900 text-lg">
                              {suggestion.title}
                            </h3>
                            <p className="text-slate-600 mt-2 whitespace-pre-wrap">
                              {suggestion.description}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 mt-4">
                          <Badge className={statusColors[suggestion.status]}>
                            {suggestion.status.replace('_', ' ')}
                          </Badge>
                          <Badge className={categoryColors[suggestion.category]}>
                            {suggestion.category.replace('_', ' ')}
                          </Badge>
                          <Badge className={priorityColors[suggestion.priority]}>
                            {suggestion.priority} priority
                          </Badge>
                          <Badge variant="outline" className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {format(new Date(suggestion.created_date), 'MMM d, yyyy')}
                          </Badge>
                        </div>

                        {suggestion.admin_notes && (
                          <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                            <p className="text-sm font-medium text-amber-900 mb-1">Admin Response:</p>
                            <p className="text-sm text-amber-800">{suggestion.admin_notes}</p>
                          </div>
                        )}
                      </div>

                      {suggestion.status === 'completed' && (
                        <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0" />
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}