import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  saveProject,
  type ProjectRecord,
  type ProjectSummary,
  type WorkspaceDocument,
} from "@/lib/project-manager";

export const projectsQueryKey = ["projects"] as const;

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: projectsQueryKey,
    queryFn: listProjects,
    enabled,
    staleTime: 20_000,
  });
}

export function useProject(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId) && enabled,
    staleTime: 0,
  });
}

export function useProjectActions() {
  const queryClient = useQueryClient();
  const invalidate = async (project: ProjectRecord) => {
    await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    queryClient.setQueryData(["project", project.id], project);
  };
  const create = useMutation({
    mutationFn: ({ name, document }: { name: string; document: WorkspaceDocument }) => createProject(name, document),
    onSuccess: invalidate,
  });
  const rename = useMutation({
    mutationFn: ({ projectId, expectedVersion, name }: { projectId: string; expectedVersion: number; name: string }) =>
      renameProject(projectId, expectedVersion, name),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: async (_, projectId) => {
      queryClient.removeQueries({ queryKey: ["project", projectId] });
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
  return { create, rename, remove };
}

export type { ProjectRecord, ProjectSummary };

export function useSaveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, expectedVersion, document }: {
      projectId: string;
      expectedVersion: number;
      document: WorkspaceDocument;
    }) => saveProject(projectId, expectedVersion, document),
    onSuccess: async (project) => {
      queryClient.setQueryData(["project", project.id], project);
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}