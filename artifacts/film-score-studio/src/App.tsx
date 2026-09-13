import { useEffect, useRef, useState } from "react";
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { setAudioStorageUser } from "@/lib/audio-storage";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import ProjectManager from "@/components/project-manager";
import ProjectWorkspace from "@/components/project-workspace";
import { quarantineLegacyWorkspace } from "@/lib/project-manager";

const queryClient = new QueryClient();
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#f59e0b",
    colorForeground: "#e7e9ee",
    colorMutedForeground: "#9ca3af",
    colorDanger: "#f87171",
    colorBackground: "#151922",
    colorInput: "#0e1117",
    colorInputForeground: "#f3f4f6",
    colorNeutral: "#303746",
    fontFamily: "DM Sans, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[#151922] rounded-2xl w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[#f3f4f6] font-display",
    headerSubtitle: "text-[#9ca3af]",
    socialButtonsBlockButtonText: "text-[#e7e9ee]",
    formFieldLabel: "text-[#e7e9ee]",
    footerActionLink: "text-[#fbbf24]",
    footerActionText: "text-[#9ca3af]",
    dividerText: "text-[#9ca3af]",
    identityPreviewEditButton: "text-[#fbbf24]",
    formFieldSuccessText: "text-emerald-400",
    alertText: "text-[#fecaca]",
    logoBox: "rounded-lg overflow-hidden",
    logoImage: "rounded-lg",
    socialButtonsBlockButton: "border-[#303746] bg-[#0e1117] hover:bg-[#202633]",
    formButtonPrimary: "bg-[#f59e0b] text-[#17100a] hover:bg-[#fbbf24]",
    formFieldInput: "border-[#303746] bg-[#0e1117] text-[#f3f4f6]",
    footerAction: "bg-transparent",
    dividerLine: "bg-[#303746]",
    alert: "border-red-500/30 bg-red-500/10",
    otpCodeFieldInput: "border-[#303746] bg-[#0e1117] text-[#f3f4f6]",
    formFieldRow: "text-[#e7e9ee]",
    main: "bg-transparent",
  },
};

function Landing() {
  const [, setLocation] = useLocation();
  return (
    <main className="min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/70 px-6 py-5 md:px-12">
        <div className="flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="Film Score Studio" className="h-10 w-10 rounded-xl" />
          <span className="font-display text-lg font-medium tracking-wide">Film Score Studio</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocation("/sign-in")} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground">Sign in</button>
          <button onClick={() => setLocation("/sign-up")} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Create account</button>
        </div>
      </header>
      <section className="relative mx-auto grid min-h-[calc(100dvh-81px)] max-w-7xl items-center gap-12 px-6 py-16 md:grid-cols-[1.1fr_0.9fr] md:px-12">
        <div className="pointer-events-none absolute -left-32 top-12 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative">
          <p className="mb-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.3em] text-primary"><span className="h-px w-8 bg-primary" /> Score the moment</p>
          <h1 className="max-w-3xl font-display text-5xl font-semibold leading-[1.02] tracking-tight md:text-7xl">A cinematic room for <span className="text-primary">musical ideas.</span></h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground">Shape scenes with a playable score, a bounded team of specialists, and a conversation that stays with your project.</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <button onClick={() => setLocation("/sign-up")} className="rounded-xl bg-primary px-6 py-3 font-semibold text-primary-foreground shadow-[0_0_28px_rgba(245,158,11,0.2)] hover:bg-primary/90">Start a score</button>
            <button onClick={() => setLocation("/sign-in")} className="rounded-xl border border-border px-6 py-3 font-semibold text-foreground hover:bg-white/5">Open your room</button>
          </div>
        </div>
        <div className="relative rounded-3xl border border-border bg-card/70 p-6 shadow-2xl backdrop-blur md:p-8">
          <div className="mb-6 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-muted-foreground"><span>Session 01</span><span className="text-emerald-400">Ready to score</span></div>
          <div className="space-y-3">
            {["Strings · Ascent motif", "Celli · Foundation", "Horns · Summit call", "Timpani · Pulse"].map((label, index) => (
              <div key={label} className="flex items-center gap-3 rounded-lg border border-border/70 bg-black/20 p-3">
                <div className="h-9 flex-1 rounded bg-gradient-to-r from-primary/70 via-primary/35 to-transparent" style={{ opacity: 0.95 - index * 0.12 }} />
                <span className="w-32 truncate text-right text-[10px] text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-between border-t border-border pt-5 text-xs"><span className="text-muted-foreground">Playable MIDI events</span><span className="font-mono text-primary">128</span></div>
        </div>
      </section>
    </main>
  );
}

function SignInPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

function SignUpPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="min-h-[100dvh] bg-background" />;
  return isSignedIn ? <Redirect to="/user-portal" /> : <Landing />;
}

function UserPortal() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  if (!isLoaded) return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-muted-foreground">Loading account…</div>;
  if (!isSignedIn) return <Redirect to="/" />;
  return (
    <AuthenticatedAccountScope>
      <ProjectManager
        accountActions={(
          <>
            <span className="hidden max-w-52 truncate text-xs text-muted-foreground sm:inline">{user?.primaryEmailAddress?.emailAddress}</span>
            <LogoutButton />
          </>
        )}
      />
    </AuthenticatedAccountScope>
  );
}

function ProtectedWorkspace() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="min-h-[100dvh] bg-background" />;
  return isSignedIn ? <AuthenticatedAccountScope><ProjectWorkspace /></AuthenticatedAccountScope> : <Redirect to="/" />;
}

function AuthenticatedAccountScope({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const userId = user?.id ?? null;
  const [scopedUserId, setScopedUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    setAudioStorageUser(userId);
    setScopedUserId(userId);
  }, [isLoaded, isSignedIn, userId]);

  if (!isLoaded || !isSignedIn || scopedUserId !== userId) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-muted-foreground">Loading account…</div>;
  }
  return <>{children}</>;
}

function LogoutButton() {
  const { signOut } = useClerk();
  return <button type="button" onClick={() => signOut({ redirectUrl: basePath || "/" })} className="rounded-md border border-border px-2.5 py-1.5 hover:bg-white/5 hover:text-foreground">Sign out</button>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUser = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    quarantineLegacyWorkspace();
    setAudioStorageUser(userId);
    if (previousUser.current !== undefined && previousUser.current !== userId) client.clear();
    previousUser.current = userId;
  }), [addListener, client]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Welcome back to the scoring room", subtitle: "Sign in to continue your projects" } },
        signUp: { start: { title: "Create your scoring room", subtitle: "Keep every musical decision in reach" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/user-portal" component={UserPortal} />
          <Route path="/workspace/:projectId" component={ProtectedWorkspace} />
          <Route component={Landing} />
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}