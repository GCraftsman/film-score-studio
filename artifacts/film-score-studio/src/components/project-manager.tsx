import { useState } from "react";
import { useUser } from "@clerk/react";
import { Film, FolderOpen, Loader2, MoreHorizontal, Plus, Pencil, Trash2 } from "lucide-react";
import { useLocation } from "wouter";
import { useProjects, useProjectActions, type ProjectSummary } from "@/hooks/use-projects";
import {
  defaultWorkspaceDocument,
  preserveLocalWorkspace,
  readRecoveredWorkspace,
  workspaceStorageKeys,
} from "@/lib/project-manager";

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="presentation">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close dialog">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  onOpen,
  onRename,
  onDelete,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article className="group flex items-center gap-4 rounded-xl border border-border bg-card/70 p-4 transition-colors hover:border-primary/40 hover:bg-card">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
        <Film className="h-5 w-5 text-primary" />
      </div>
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate font-display font-medium">{project.name}</div>
        <div className="mt-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          Saved {new Date(project.updatedAt).toLocaleDateString()} · revision {project.version}
        </div>
      </button>
      <div className="relative">
        <button
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded-md p-2 text-muted-foreground hover:bg-white/5 hover:text-foreground"
          aria-label={`Actions for ${project.name}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-10 z-10 min-w-36 rounded-lg border border-border bg-card p-1 shadow-xl">
            <button onClick={() => { setMenuOpen(false); onRename(); }} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-white/5">
              <Pencil className="h-3.5 w-3.5" /> Rename
            </button>
            <button onClick={() => { setMenuOpen(false); onDelete(); }} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-destructive hover:bg-destructive/10">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export default function ProjectManager({ accountActions }: { accountActions?: React.ReactNode } = {}) {
  const [, setLocation] = useLocation();
  const { user } = useUser();
  const userId = user?.id;
  const projects = useProjects();
  const actions = useProjectActions();
  const [modal, setModal] = useState<"create" | "rename" | "delete" | null>(null);
  const [selected, setSelected] = useState<ProjectSummary | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const recovered = userId ? readRecoveredWorkspace(userId) : null;

  const close = () => {
    setModal(null);
    setSelected(null);
    setError("");
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Enter a project name."); return; }
    try {
      // Preserve any legacy/local score for the explicit recovery action, but
      // never seed a new authenticated project with another document's tracks.
      preserveLocalWorkspace(userId);
      const result = await actions.create.mutateAsync({
        name: trimmed,
        document: defaultWorkspaceDocument(),
      });
      close();
      setLocation(`/workspace/${result.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create project.");
    }
  };

  const importLocal = async () => {
    if (!recovered) return;
    try {
      const result = await actions.create.mutateAsync({
        name: "Recovered local workspace",
        document: recovered,
      });
      window.localStorage.removeItem(workspaceStorageKeys(userId).recovery);
      setLocation(`/workspace/${result.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import the local workspace.");
    }
  };

  const rename = async () => {
    if (!selected || !name.trim()) { setError("Enter a project name."); return; }
    try {
      await actions.rename.mutateAsync({ projectId: selected.id, expectedVersion: selected.version, name: name.trim() });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename project.");
    }
  };

  const remove = async () => {
    if (!selected) return;
    try {
      await actions.remove.mutateAsync(selected.id);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete project.");
    }
  };

  const openRename = (project: ProjectSummary) => {
    setSelected(project);
    setName(project.name);
    setModal("rename");
  };
  const openDelete = (project: ProjectSummary) => {
    setSelected(project);
    setModal("delete");
  };

  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <header className="flex flex-col gap-4 border-b border-border bg-card/80 px-4 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0">
            <div className="font-display text-lg font-medium">Film Score Studio</div>
            <div className="text-[9px] uppercase tracking-[0.2em] text-primary">Your projects</div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          {accountActions}
          <button onClick={() => { setName(""); setModal("create"); }} className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            <Plus className="h-4 w-4" /> New project
          </button>
        </div>
      </header>
      <section className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-8">
          <p className="mb-2 text-xs uppercase tracking-[0.22em] text-primary">Scoring room</p>
          <h1 className="font-display text-3xl font-semibold">Open a composition</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">Projects are private to your account and preserve your score, conversation, undo history, proposals, and microphone notes across devices.</p>
        </div>
        {projects.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading projects…</div>}
        {projects.error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">Could not load projects. Please refresh and try again.</div>}
        {!projects.isLoading && !projects.error && projects.data?.projects.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center">
            <FolderOpen className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
            <h2 className="font-display text-lg font-medium">No projects yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">Create one to keep your score available wherever you sign in.</p>
            <button onClick={() => { setName(""); setModal("create"); }} className="mt-5 rounded-lg border border-primary/40 px-4 py-2 text-sm text-primary hover:bg-primary/10">Create first project</button>
          </div>
        )}
        {recovered && (
          <div className="mb-3 flex items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
            <div>
              <div className="text-sm font-semibold text-primary">Local workspace found</div>
              <p className="mt-1 text-xs text-muted-foreground">A previous browser workspace is preserved and ready to import.</p>
            </div>
            <button onClick={() => void importLocal()} disabled={actions.create.isPending} className="shrink-0 rounded-lg border border-primary/40 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50">Import</button>
          </div>
        )}
        <div className="grid gap-3">
          {projects.data?.projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={() => setLocation(`/workspace/${project.id}`)}
              onRename={() => openRename(project)}
              onDelete={() => openDelete(project)}
            />
          ))}
        </div>
      </section>

      {modal === "create" && (
        <Modal title="Create project" onClose={close}>
          <label className="block text-xs font-semibold uppercase tracking-widest text-muted-foreground" htmlFor="new-project-name">Project name</label>
          <input id="new-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="Untitled cue" className="mt-2 w-full rounded-lg border border-input bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-primary" />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button onClick={close} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-white/5">Cancel</button><button onClick={() => void create()} disabled={actions.create.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{actions.create.isPending ? "Creating…" : "Create"}</button></div>
        </Modal>
      )}
      {modal === "rename" && selected && (
        <Modal title="Rename project" onClose={close}>
          <label className="block text-xs font-semibold uppercase tracking-widest text-muted-foreground" htmlFor="rename-project-name">Project name</label>
          <input id="rename-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} className="mt-2 w-full rounded-lg border border-input bg-black/20 px-3 py-2.5 text-sm outline-none focus:border-primary" />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button onClick={close} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-white/5">Cancel</button><button onClick={() => void rename()} disabled={actions.rename.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{actions.rename.isPending ? "Saving…" : "Rename"}</button></div>
        </Modal>
      )}
      {modal === "delete" && selected && (
        <Modal title="Delete project" onClose={close}>
          <p className="text-sm leading-relaxed text-muted-foreground">Delete <span className="font-semibold text-foreground">{selected.name}</span>? This removes its saved document and audio metadata. This cannot be undone.</p>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button onClick={close} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-white/5">Cancel</button><button onClick={() => void remove()} disabled={actions.remove.isPending} className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground disabled:opacity-50">{actions.remove.isPending ? "Deleting…" : "Delete project"}</button></div>
        </Modal>
      )}
    </main>
  );
}