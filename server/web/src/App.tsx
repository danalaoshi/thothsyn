import { AuthProvider, useAuth } from "./context/AuthContext";
import AuthScreen from "./components/AuthScreen";
import Dashboard from "./components/Dashboard";

function Root() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        加载中…
      </div>
    );
  }
  return session ? <Dashboard /> : <AuthScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <div className="min-h-[100dvh]">
        <Root />
      </div>
    </AuthProvider>
  );
}
