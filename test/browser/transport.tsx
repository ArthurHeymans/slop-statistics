// Test/demo-only identity/transport adapter. Business handlers and database remain real
// Lakebed implementations (see dashboard.spec.js); Google sign-in is not simulated as security evidence.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
function useRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => { const refresh = () => setRevision(v => v + 1); window.addEventListener('refresh', refresh); return () => window.removeEventListener('refresh', refresh); }, []);
  return revision;
}
async function rpc(kind: string, name: string, args: unknown[]) {
  const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': sessionStorage.getItem('test-auth-user') ?? 'owner' }, body: JSON.stringify({ kind, name, args }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
export function useAuth() {
  useRevision();
  const user = sessionStorage.getItem('test-auth-user') ?? 'owner';
  return { isLoading: false, isSignedIn: user !== 'signed-out', userId: user === 'signed-out' ? null : user, error: null, displayName: 'Test owner' };
}
export const signOut = async () => { sessionStorage.setItem('test-auth-user', 'signed-out'); window.dispatchEvent(new Event('refresh')); };
export const retryAuth = async () => {};
export const SignInWithGoogle = () => <button>Sign in with Google</button>;
export const Router = ({ children }: { children: ComponentChildren }) => <>{children}</>;
export function Link({ to, children, ...props }: { to: string; children: ComponentChildren; className?: string }) {
  return <a {...props} href={to} onClick={e => { e.preventDefault(); history.pushState({}, '', to); window.dispatchEvent(new Event('popstate')); }}>{children}</a>;
}
export function useLocation() {
  const [pathname, setPathname] = useState(location.pathname);
  useEffect(() => { const changed = () => setPathname(location.pathname); window.addEventListener('popstate', changed); return () => window.removeEventListener('popstate', changed); }, []);
  return { pathname };
}
export function createClient<_T>() {
  return {
    useQuery(name: string) {
      const revision = useRevision(); const [data, setData] = useState<unknown>();
      useEffect(() => { let alive = true; void rpc('query', name, []).then(result => { if (alive) setData(result); }); return () => { alive = false; }; }, [name, revision]);
      return data;
    },
    useMutation(name: string) {
      return async (...args: unknown[]) => { const result = await rpc('mutation', name, args); window.dispatchEvent(new Event('refresh')); return result; };
    },
    usePaginatedQuery(name: string, args: object, options: { initialNumItems: number }) {
      const revision = useRevision();
      const [data, setData] = useState({ page: [] as unknown[], continueCursor: null as string | null, isDone: false });
      const loading = useRef(false), generation = useRef(0);
      const load = async (cursor: string | null) => {
        if (cursor && loading.current) return;
        const requestGeneration = generation.current;
        loading.current = true;
        try {
          const result = await rpc('query', name, [{ ...args, pagination: { cursor, numItems: options.initialNumItems } }]);
          // A refresh invalidates in-flight pages; never append them to a new snapshot.
          if (requestGeneration === generation.current) {
            setData(previous => ({ ...result, page: cursor ? [...previous.page, ...result.page] : result.page }));
          }
        } finally { if (requestGeneration === generation.current) loading.current = false; }
      };
      useEffect(() => {
        generation.current++;
        void load(null);
        return () => { generation.current++; };
      }, [name, revision]);
      return { ...data, loadMore: () => { if (data.continueCursor) void load(data.continueCursor); } };
    }
  };
}
