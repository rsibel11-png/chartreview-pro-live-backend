import React from 'react';
import { useUploadManager } from './UploadManager';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Upload, CheckCircle, Loader2, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';

export default function UploadProgress() {
  const { files, uploading, progress, stopUpload, clearCompleted } = useUploadManager();
  const navigate = useNavigate();

  const activeFiles = files.filter(f => f.status !== 'completed');
  const completedFiles = files.filter(f => f.status === 'completed');
  const hasActive = activeFiles.length > 0;
  const hasCompleted = completedFiles.length > 0;

  if (!hasActive && !hasCompleted) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 max-w-[90vw]">
      <Card className="shadow-2xl border-2 border-blue-200">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {uploading ? (
                <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
              ) : (
                <CheckCircle className="w-5 h-5 text-green-600" />
              )}
              <h3 className="font-semibold text-slate-900">
                {uploading ? 'Uploading...' : 'Uploads Complete'}
              </h3>
            </div>
            <div className="flex items-center gap-1">
              {!uploading && hasCompleted && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearCompleted}
                  className="h-8 text-slate-600"
                >
                  Clear
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(createPageUrl('Upload'))}
                className="h-8 text-blue-600"
              >
                View
              </Button>
            </div>
          </div>

          {hasActive && (
            <div className="space-y-2">
              {activeFiles.slice(0, 3).map(file => (
                <div key={file.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-700 truncate flex-1 mr-2">
                      {file.name}
                    </span>
                    <span className="text-slate-500 text-xs">
                      {progress[file.id] || 0}%
                    </span>
                  </div>
                  <Progress value={progress[file.id] || 0} className="h-1.5" />
                </div>
              ))}
              {activeFiles.length > 3 && (
                <p className="text-xs text-slate-500">
                  +{activeFiles.length - 3} more files
                </p>
              )}
            </div>
          )}

          {hasCompleted && !hasActive && (
            <div className="text-sm text-green-700 bg-green-50 rounded-lg p-2">
              {completedFiles.length} file{completedFiles.length !== 1 ? 's' : ''} uploaded successfully
            </div>
          )}

          {uploading && (
            <Button
              variant="outline"
              size="sm"
              onClick={stopUpload}
              className="w-full text-red-600 border-red-300 hover:bg-red-50"
            >
              <X className="w-4 h-4 mr-2" />
              Stop Upload
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}