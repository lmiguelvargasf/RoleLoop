export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: "owner" | "manager";
}
export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}
