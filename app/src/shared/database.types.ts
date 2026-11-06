export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_admins: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      drafts: {
        Row: {
          id: string
          opportunity_id: string
          payload: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          id: string
          opportunity_id: string
          payload: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          id?: string
          opportunity_id?: string
          payload?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "drafts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_workspace_opportunity_fkey"
            columns: ["workspace_id", "opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string
          id: string
          payload: Json
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id: string
          payload: Json
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunities: {
        Row: {
          id: string
          kind: string
          payload: Json
          source_key: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          id: string
          kind: string
          payload: Json
          source_key: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          id?: string
          kind?: string
          payload?: Json
          source_key?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "opportunities_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          id: string
          payload: Json
          requested_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id: string
          payload: Json
          requested_by?: string | null
          status: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          requested_by?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace"
            referencedColumns: ["id"]
          },
        ]
      }
      runtime: {
        Row: {
          key: string
          payload: Json
          updated_at: string
        }
        Insert: {
          key: string
          payload: Json
          updated_at?: string
        }
        Update: {
          key?: string
          payload?: Json
          updated_at?: string
        }
        Relationships: []
      }
      workspace: {
        Row: {
          id: string
          name: string
          owner_user_id: string | null
          payload: Json
          updated_at: string
        }
        Insert: {
          id: string
          name?: string
          owner_user_id?: string | null
          payload: Json
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          owner_user_id?: string | null
          payload?: Json
          updated_at?: string
        }
        Relationships: []
      }
      workspace_members: {
        Row: {
          created_at: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          role: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_runtime: {
        Row: {
          key: string
          payload: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          key: string
          payload: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          key?: string
          payload?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_runtime_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspace"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_worker_lease: { Args: { owner: string }; Returns: boolean }
      update_workspace_profile_if_current: {
        Args: {
          target_workspace: string
          expected_profile: Json
          workspace_patch: Json
        }
        Returns: { id: string }[]
      }
      claim_initial_owner: {
        Args: { owner_uuid: string; token_digest: string }
        Returns: {
          id: string
          name: string
          owner_user_id: string | null
          payload: Json
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "workspace"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_run: {
        Args: never
        Returns: {
          created_at: string
          id: string
          payload: Json
          requested_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      enqueue_run: {
        Args: { run_payload: Json; target_workspace: string }
        Returns: {
          created_at: string
          id: string
          payload: Json
          requested_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "runs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      ensure_workspace: {
        Args: { initial_payload: Json }
        Returns: {
          id: string
          name: string
          owner_user_id: string | null
          payload: Json
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "workspace"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      has_workspace_access: {
        Args: { target_workspace: string }
        Returns: boolean
      }
      manage_workspace_member: {
        Args: {
          member_user_id: string
          operation: string
          target_workspace: string
        }
        Returns: undefined
      }
      owns_workspace: { Args: { target_workspace: string }; Returns: boolean }
      release_worker_lease: { Args: { owner: string }; Returns: boolean }
      renew_worker_lease: { Args: { owner: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

