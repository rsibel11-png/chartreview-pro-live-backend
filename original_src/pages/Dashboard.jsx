import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { 
  FileText, 
  Upload, 
  Copy, 
  FileCheck, 
  TrendingUp,
  AlertCircle,
  Calendar,
  BarChart3,
  HelpCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Tutorial from "../components/Tutorial";

export default function Dashboard() {
  const [showTutorial, setShowTutorial] = useState(false);

  useEffect(() => {
    // Check if user has seen the tutorial
    const hasSeenTutorial = localStorage.getItem('hasSeenTutorial');
    if (!hasSeenTutorial) {
      setShowTutorial(true);
    }
  }, []);

  const handleCloseTutorial = () => {
    localStorage.setItem('hasSeenTutorial', 'true');
    setShowTutorial(false);
  };

  const { data: documents = [], isLoading: docsLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: () => base44.entities.Document.list('-created_date', 100),
    initialData: [],
  });

  const { data: summaries = [], isLoading: summariesLoading } = useQuery({
    queryKey: ['summaries'],
    queryFn: () => base44.entities.MedicalSummary.list('-created_date', 50),
    initialData: [],
  });

  const stats = {
    totalDocuments: documents.length,
    medicalDocs: documents.filter(d => d.category === 'medical').length,
    legalDocs: documents.filter(d => d.category === 'legal').length,
    duplicates: documents.filter(d => d.is_duplicate).length,
    summaries: summaries.length,
    pendingProcessing: documents.filter(d => d.processing_status === 'pending' || d.processing_status === 'processing').length,
  };

  // Group documents by upload time (within 5 minutes = same upload session)
  const uploadSessions = documents.reduce((sessions, doc) => {
    if (!doc || !doc.created_date) return sessions;
    
    const uploadTime = new Date(doc.created_date).getTime();
    
    // Find a session within 5 minutes
    const existingSession = sessions.find(session => {
      const sessionTime = new Date(session.timestamp).getTime();
      return Math.abs(uploadTime - sessionTime) < 5 * 60 * 1000; // 5 minutes
    });
    
    if (existingSession) {
      existingSession.documents.push(doc);
    } else {
      sessions.push({
        timestamp: doc.created_date,
        documents: [doc]
      });
    }
    
    return sessions;
  }, []);
  
  // Sort sessions by most recent first
  uploadSessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Get the most recent upload session
  const latestSession = uploadSessions[0];
  const recentDocuments = documents.slice(0, 20); // Show more documents

  return (
    <div className="p-6 md:p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-600">Medical-Legal document management overview</p>
        </div>
        <Button 
          variant="outline" 
          onClick={() => setShowTutorial(true)}
          className="gap-2"
        >
          <HelpCircle className="w-4 h-4" />
          Tutorial
        </Button>
      </div>

      {/* Tutorial Dialog */}
      {showTutorial && <Tutorial onClose={handleCloseTutorial} />}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Link to={createPageUrl("Upload")}>
          <Card className="hover:shadow-lg transition-all duration-300 cursor-pointer border-2 border-transparent hover:border-blue-200 bg-gradient-to-br from-blue-50 to-cyan-50">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-md">
                  <Upload className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-slate-600 font-medium">Upload New</p>
                  <p className="text-lg font-bold text-slate-900">Documents</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to={createPageUrl("Library")}>
          <Card className="hover:shadow-lg transition-all duration-300 cursor-pointer border-2 border-transparent hover:border-purple-200 bg-gradient-to-br from-purple-50 to-pink-50">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-md">
                  <FileText className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-slate-600 font-medium">View All</p>
                  <p className="text-lg font-bold text-slate-900">Library</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to={createPageUrl("Duplicates")}>
          <Card className="hover:shadow-lg transition-all duration-300 cursor-pointer border-2 border-transparent hover:border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shadow-md">
                  <Copy className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-slate-600 font-medium">Manage</p>
                  <p className="text-lg font-bold text-slate-900">Duplicates</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to={createPageUrl("MedicalSummaries")}>
          <Card className="hover:shadow-lg transition-all duration-300 cursor-pointer border-2 border-transparent hover:border-green-200 bg-gradient-to-br from-green-50 to-emerald-50">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center shadow-md">
                  <FileCheck className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-slate-600 font-medium">Create</p>
                  <p className="text-lg font-bold text-slate-900">Summaries</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card className="bg-white shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-600">Total Documents</CardTitle>
              <FileText className="w-4 h-4 text-slate-400" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{stats.totalDocuments}</p>
          </CardContent>
        </Card>

        <Card className="bg-white shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-600">Medical Records</CardTitle>
              <BarChart3 className="w-4 h-4 text-cyan-500" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-cyan-600">{stats.medicalDocs}</p>
          </CardContent>
        </Card>

        <Card className="bg-white shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-600">Legal Documents</CardTitle>
              <BarChart3 className="w-4 h-4 text-blue-500" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-blue-600">{stats.legalDocs}</p>
          </CardContent>
        </Card>

        <Card className="bg-white shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-600">Duplicates</CardTitle>
              <AlertCircle className="w-4 h-4 text-amber-500" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-amber-600">{stats.duplicates}</p>
          </CardContent>
        </Card>

        <Card className="bg-white shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-600">Summaries</CardTitle>
              <FileCheck className="w-4 h-4 text-green-500" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600">{stats.summaries}</p>
          </CardContent>
        </Card>

        <Card className="bg-white shadow-md">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-slate-600">Processing</CardTitle>
              <TrendingUp className="w-4 h-4 text-purple-500" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-purple-600">{stats.pendingProcessing}</p>
          </CardContent>
        </Card>
      </div>

      {/* Latest Upload Session */}
      {latestSession && (
        <Card className="shadow-lg border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white">
          <CardHeader className="border-b border-blue-200">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl font-bold text-slate-900">Latest Upload Session</CardTitle>
                <p className="text-sm text-slate-600 mt-1">
                  {new Date(latestSession.timestamp).toLocaleString()} • {latestSession.documents.length} document{latestSession.documents.length !== 1 ? 's' : ''}
                </p>
              </div>
              <Link to={createPageUrl("Library")}>
                <Button variant="outline" size="sm">View All</Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-blue-100">
              {latestSession.documents.map((doc) => (
                <div key={doc.id} className="p-4 hover:bg-blue-100/50 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        doc.category === 'medical' 
                          ? 'bg-cyan-100' 
                          : doc.category === 'legal' 
                          ? 'bg-blue-100' 
                          : 'bg-slate-100'
                      }`}>
                        <FileText className={`w-5 h-5 ${
                          doc.category === 'medical' 
                            ? 'text-cyan-600' 
                            : doc.category === 'legal' 
                            ? 'text-blue-600' 
                            : 'text-slate-600'
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-900 truncate">{doc.title}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className={
                            doc.category === 'medical' 
                              ? 'bg-cyan-50 text-cyan-700 border-cyan-200' 
                              : doc.category === 'legal'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-slate-50 text-slate-700 border-slate-200'
                          }>
                            {doc.category || 'Uncategorized'}
                          </Badge>
                          {doc.processing_status && (
                            <Badge variant="outline" className={
                              doc.processing_status === 'completed'
                                ? 'bg-green-50 text-green-700 border-green-200'
                                : doc.processing_status === 'error'
                                ? 'bg-red-50 text-red-700 border-red-200'
                                : 'bg-yellow-50 text-yellow-700 border-yellow-200'
                            }>
                              {doc.processing_status}
                            </Badge>
                          )}
                          {doc.folder && (
                            <span className="text-xs text-slate-600">📁 {doc.folder}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(doc.created_date).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Documents */}
      <Card className="shadow-lg">
        <CardHeader className="border-b border-slate-200">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl font-bold">All Recent Documents</CardTitle>
            <Link to={createPageUrl("Library")}>
              <Button variant="outline" size="sm">View All</Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {recentDocuments.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {recentDocuments.map((doc) => (
                <div key={doc.id} className="p-4 hover:bg-slate-50 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        doc.category === 'medical' 
                          ? 'bg-cyan-100' 
                          : doc.category === 'legal' 
                          ? 'bg-blue-100' 
                          : 'bg-slate-100'
                      }`}>
                        <FileText className={`w-5 h-5 ${
                          doc.category === 'medical' 
                            ? 'text-cyan-600' 
                            : doc.category === 'legal' 
                            ? 'text-blue-600' 
                            : 'text-slate-600'
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-900 truncate">{doc.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className={
                            doc.category === 'medical' 
                              ? 'bg-cyan-50 text-cyan-700 border-cyan-200' 
                              : doc.category === 'legal'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-slate-50 text-slate-700 border-slate-200'
                          }>
                            {doc.category || 'Uncategorized'}
                          </Badge>
                          {doc.subcategory && (
                            <span className="text-xs text-slate-500">
                              {doc.subcategory.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(doc.created_date).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-12 text-center">
              <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500">No documents yet. Upload your first document to get started.</p>
              <Link to={createPageUrl("Upload")}>
                <Button className="mt-4 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700">
                  <Upload className="w-4 h-4 mr-2" />
                  Upload Documents
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}