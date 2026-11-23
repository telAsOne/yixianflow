export type ProjectRole = "owner" | "admin" | "editor" | "viewer";
export type ProjectMember = { userId: number; name: string; role: ProjectRole };
export type ProjectActivity = { id: string; userId: number; name: string; action: string; path: string; nodeIds: string[]; createdAt: string; platformOnly?: boolean };
export type ProjectPresence = {
  sessionId: string; userId: number; name: string; color: string; admin: boolean; agent: boolean; platformOnly: boolean;
  path: string; panel: "canvas" | "document"; visible: boolean; activity: string;
  cursor?: { x: number; y: number }; selected: string[]; viewport?: { x: number; y: number; zoom: number };
};
export type ProjectEvent = { type: "ready" | "permissions" } | { type: "canvas"; path: string; revision?: string } | { type: "file"; path: string }
  | { type: "presence"; members: ProjectPresence[]; platformOnly?: boolean; changes?: ProjectPresence[]; removed?: string[] }
  | { type: "presenceDelta"; members: ProjectPresence[]; removed: string[] }
  | { type: "activity"; activity: ProjectActivity };
