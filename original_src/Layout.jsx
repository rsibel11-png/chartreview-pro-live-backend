import React from "react";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { 
  FileText, 
  LayoutDashboard, 
  Upload, 
  Library, 
  Copy, 
  FileCheck,
  Users,
  LogOut,
  Menu,
  MessageSquarePlus,
  Settings,
  CreditCard,
  Scissors,
  AlertTriangle
} from "lucide-react";
import { UploadProvider } from "@/components/UploadManager";
import UploadProgress from "@/components/UploadProgress";
import { SummaryGenerationProvider } from "@/components/SummaryGenerationManager";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";

const navigationItems = [
  {
    title: "Dashboard",
    url: createPageUrl("Dashboard"),
    icon: LayoutDashboard,
  },
  {
    title: "Upload Documents",
    url: createPageUrl("Upload"),
    icon: Upload,
  },
  {
    title: "Document Library",
    url: createPageUrl("Library"),
    icon: Library,
  },
  {
    title: "Duplicate Manager",
    url: createPageUrl("Duplicates"),
    icon: Copy,
  },
  {
    title: "Medical Summaries",
    url: createPageUrl("MedicalSummaries"),
    icon: FileCheck,
  },
  {
    title: "Split PDF",
    url: createPageUrl("SplitPdf"),
    icon: Scissors,
  },
  {
    title: "Subscription",
    url: createPageUrl("Subscription"),
    icon: CreditCard,
  },
  {
    title: "Breach Notifications",
    url: createPageUrl("BreachNotifications"),
    icon: AlertTriangle,
  },
  {
    title: "Invite Users",
    url: createPageUrl("Users"),
    icon: Users,
  },
  {
    title: "Suggestions",
    url: createPageUrl("Suggestions"),
    icon: MessageSquarePlus,
  },
  {
    title: "Settings",
    url: createPageUrl("Settings"),
    icon: Settings,
  },
];

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const [user, setUser] = React.useState(null);

  React.useEffect(() => {
    const fetchUser = async () => {
      try {
        const userData = await base44.auth.me();
        setUser(userData);
      } catch (error) {
        console.error("Error fetching user:", error);
      }
    };
    fetchUser();
  }, []);

  // Prevent screen/computer from sleeping while app is open
  React.useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    let wakeLock = null;
    const requestWakeLock = async () => {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {
        // silently ignore if not supported or denied
      }
    };
    requestWakeLock();
    // Re-acquire lock when page becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestWakeLock();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      wakeLock?.release();
    };
  }, []);

  const handleLogout = () => {
    base44.auth.logout();
  };

  return (
    <SummaryGenerationProvider><UploadProvider>
      <SidebarProvider>
        <div className="min-h-screen flex w-full bg-gradient-to-br from-slate-50 to-blue-50">
        <style>{`
          :root {
            --primary: 214 95% 36%;
            --primary-foreground: 0 0% 100%;
            --secondary: 188 82% 37%;
            --secondary-foreground: 0 0% 100%;
            --accent: 210 40% 96%;
            --accent-foreground: 222 47% 11%;
            --muted: 210 40% 96%;
            --muted-foreground: 215 16% 47%;
          }
        `}</style>
        
        <Sidebar className="border-r border-slate-200 bg-white shadow-sm">
          <SidebarHeader className="border-b border-slate-200 p-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-cyan-500 rounded-lg flex items-center justify-center shadow-md">
                <FileText className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="font-bold text-lg text-slate-900">ChartReview Pro</h2>
                <p className="text-xs text-slate-500">Document Management</p>
              </div>
            </div>
          </SidebarHeader>
          
          <SidebarContent className="p-3">
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2">
                Navigation
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="space-y-1">
                  {navigationItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton 
                        asChild 
                        className={`hover:bg-blue-50 hover:text-blue-700 transition-all duration-200 rounded-lg ${
                          location.pathname === item.url 
                            ? 'bg-gradient-to-r from-blue-50 to-cyan-50 text-blue-700 shadow-sm' 
                            : 'text-slate-700'
                        }`}
                      >
                        <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                          <item.icon className="w-4 h-4" />
                          <span className="font-medium text-sm">{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="border-t border-slate-200 p-4">
            <div className="space-y-3">
              <div className="flex items-center gap-3 px-2">
                <div className="w-9 h-9 bg-gradient-to-br from-slate-300 to-slate-400 rounded-full flex items-center justify-center shadow-sm">
                  <span className="text-slate-700 font-semibold text-sm">
                    {user?.full_name?.[0]?.toUpperCase() || 'U'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-900 text-sm truncate">
                    {user?.full_name || 'User'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">{user?.email}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="w-full justify-start text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="bg-white border-b border-slate-200 px-6 py-4 md:hidden shadow-sm">
            <div className="flex items-center gap-4">
              <SidebarTrigger className="hover:bg-slate-100 p-2 rounded-lg transition-colors duration-200">
                <Menu className="w-5 h-5" />
              </SidebarTrigger>
              <h1 className="text-xl font-bold text-slate-900">ChartReview Pro</h1>
            </div>
          </header>

          <div className="flex-1 overflow-auto">
            {children}
          </div>
          </main>

          <UploadProgress />
          </div>
          </SidebarProvider>
          </UploadProvider></SummaryGenerationProvider>
          );
          }