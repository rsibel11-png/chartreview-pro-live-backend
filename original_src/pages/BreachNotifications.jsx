import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Send, CheckCircle, Clock, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

export default function BreachNotifications() {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [formData, setFormData] = useState({
    event_type: "unauthorized_access",
    severity: "medium",
    description: "",
    affected_users: ""
  });

  const { data: breaches = [], isLoading } = useQuery({
    queryKey: ['breaches'],
    queryFn: () => base44.entities.BreachNotification.list('-created_date', 100),
  });

  const notifyMutation = useMutation({
    mutationFn: async () => {
      const affected_users = formData.affected_users
        .split('\n')
        .map(email => email.trim())
        .filter(email => email.length > 0);

      return base44.functions.invoke('notifyBreach', {
        event_type: formData.event_type,
        severity: formData.severity,
        description: formData.description,
        affected_users
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['breaches'] });
      setShowDialog(false);
      setFormData({
        event_type: "unauthorized_access",
        severity: "medium",
        description: "",
        affected_users: ""
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status, notes }) =>
      base44.entities.BreachNotification.update(id, {
        status,
        investigation_notes: notes
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['breaches'] });
    },
  });

  const severityColors = {
    low: "bg-blue-100 text-blue-800",
    medium: "bg-yellow-100 text-yellow-800",
    high: "bg-orange-100 text-orange-800",
    critical: "bg-red-100 text-red-800"
  };

  const statusIcons = {
    pending: <Clock className="w-4 h-4" />,
    notified: <Send className="w-4 h-4" />,
    investigating: <AlertTriangle className="w-4 h-4" />,
    resolved: <CheckCircle className="w-4 h-4" />
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-red-600 to-orange-500 rounded-lg flex items-center justify-center shadow-md">
            <AlertTriangle className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Breach Notifications</h1>
            <p className="text-slate-600 mt-1">Manage security events and user notifications</p>
          </div>
        </div>

        <Button
          onClick={() => setShowDialog(true)}
          className="bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700"
        >
          <Zap className="w-4 h-4 mr-2" />
          Report Security Event
        </Button>

        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Report Security Event</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700 mb-1 block">Event Type</label>
                <Select value={formData.event_type} onValueChange={(value) => setFormData({...formData, event_type: value})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unauthorized_access">Unauthorized Access</SelectItem>
                    <SelectItem value="data_exposure">Data Exposure</SelectItem>
                    <SelectItem value="failed_authentication">Failed Authentication</SelectItem>
                    <SelectItem value="suspicious_activity">Suspicious Activity</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-1 block">Severity</label>
                <Select value={formData.severity} onValueChange={(value) => setFormData({...formData, severity: value})}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-1 block">Description</label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({...formData, description: e.target.value})}
                  placeholder="Details about the security event..."
                  className="h-24"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-1 block">Affected User Emails (one per line)</label>
                <Textarea
                  value={formData.affected_users}
                  onChange={(e) => setFormData({...formData, affected_users: e.target.value})}
                  placeholder="user1@example.com&#10;user2@example.com"
                  className="h-24"
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
              <Button
                onClick={() => notifyMutation.mutate()}
                disabled={notifyMutation.isPending || !formData.description}
                className="bg-red-600 hover:bg-red-700"
              >
                {notifyMutation.isPending ? 'Sending...' : 'Send Notifications'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="space-y-4">
          {isLoading ? (
            <Card><CardContent className="p-8 text-center text-slate-500">Loading breach records...</CardContent></Card>
          ) : breaches.length === 0 ? (
            <Alert><AlertDescription>No breach notifications recorded yet.</AlertDescription></Alert>
          ) : (
            breaches.map((breach) => (
              <Card key={breach.id} className="border-l-4 border-l-red-500">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-2">
                      <div className="flex items-center gap-3">
                        {statusIcons[breach.status]}
                        <CardTitle className="text-lg">{breach.event_type.replace(/_/g, ' ')}</CardTitle>
                        <Badge className={severityColors[breach.severity]}>
                          {breach.severity}
                        </Badge>
                      </div>
                      <CardDescription>{breach.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-slate-600">Detected:</span>
                      <p className="font-medium">{new Date(breach.detected_date).toLocaleString()}</p>
                    </div>
                    <div>
                      <span className="text-slate-600">Status:</span>
                      <p className="font-medium capitalize">{breach.status}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-slate-600">Affected Users: {breach.affected_users.length}</span>
                    </div>
                  </div>

                  {breach.investigation_notes && (
                    <div className="bg-slate-50 p-3 rounded border border-slate-200">
                      <p className="text-sm text-slate-700">{breach.investigation_notes}</p>
                    </div>
                  )}

                  {breach.notification_sent && (
                    <Alert className="bg-green-50 border-green-200">
                      <AlertDescription className="text-green-900 text-sm">
                        Notifications sent on {new Date(breach.notification_sent_date).toLocaleString()}
                      </AlertDescription>
                    </Alert>
                  )}

                  {breach.status !== 'resolved' && (
                    <Select
                      value={breach.status}
                      onValueChange={(status) => updateMutation.mutate({ id: breach.id, status })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="notified">Notified</SelectItem>
                        <SelectItem value="investigating">Investigating</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}