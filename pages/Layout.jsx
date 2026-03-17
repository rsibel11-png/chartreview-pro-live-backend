
// Shared layout component - not a page, just exported for use
export default function Layout({ children, currentPage, onNavigate }) {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '🏠' },
    { id: 'patients', label: 'Patients', icon: '👤' },
    { id: 'documents', label: 'Documents', icon: '📄' },
    { id: 'summaries', label: 'Summaries', icon: '📋' },
    { id: 'macros', label: 'Notes Macros', icon: '📝' },
    { id: 'admin', label: 'Admin', icon: '⚙️' },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'Inter, sans-serif', background: '#f8fafc' }}>
      {/* Sidebar */}
      <div style={{ width: 220, background: '#1e3a5f', color: 'white', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '24px 20px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>ChartReview Pro</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>HIPAA Compliant</div>
        </div>
        <nav style={{ flex: 1, padding: '12px 0' }}>
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '10px 20px', border: 'none',
                background: currentPage === item.id ? 'rgba(255,255,255,0.15)' : 'transparent',
                color: currentPage === item.id ? '#fff' : 'rgba(255,255,255,0.7)',
                cursor: 'pointer', fontSize: 14, textAlign: 'left',
                borderLeft: currentPage === item.id ? '3px solid #4a9eff' : '3px solid transparent',
                transition: 'all 0.15s'
              }}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
          🔒 PHI stored on AWS
        </div>
      </div>
      {/* Main content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
