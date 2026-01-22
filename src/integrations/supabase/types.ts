export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      account_corrections: {
        Row: {
          account_code: string
          corrected_category: string
          corrected_subcategory: string
          created_at: string
          id: string
          original_category: string | null
          original_subcategory: string | null
          updated_at: string
          upload_id: string
          user_id: string
        }
        Insert: {
          account_code: string
          corrected_category: string
          corrected_subcategory: string
          created_at?: string
          id?: string
          original_category?: string | null
          original_subcategory?: string | null
          updated_at?: string
          upload_id: string
          user_id: string
        }
        Update: {
          account_code?: string
          corrected_category?: string
          corrected_subcategory?: string
          created_at?: string
          id?: string
          original_category?: string | null
          original_subcategory?: string | null
          updated_at?: string
          upload_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_corrections_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      account_mappings: {
        Row: {
          account_code: string
          account_name: string
          classification: Database["public"]["Enums"]["account_classification"]
          created_at: string
          id: string
          is_cash_account: boolean
          is_retained_earnings: boolean
          line_item: string
          normal_balance: string
          statement: Database["public"]["Enums"]["financial_statement"]
          updated_at: string
          user_id: string
        }
        Insert: {
          account_code: string
          account_name: string
          classification: Database["public"]["Enums"]["account_classification"]
          created_at?: string
          id?: string
          is_cash_account?: boolean
          is_retained_earnings?: boolean
          line_item: string
          normal_balance: string
          statement: Database["public"]["Enums"]["financial_statement"]
          updated_at?: string
          user_id: string
        }
        Update: {
          account_code?: string
          account_name?: string
          classification?: Database["public"]["Enums"]["account_classification"]
          created_at?: string
          id?: string
          is_cash_account?: boolean
          is_retained_earnings?: boolean
          line_item?: string
          normal_balance?: string
          statement?: Database["public"]["Enums"]["financial_statement"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_address: string | null
          metadata: Json | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          code: string | null
          created_at: string
          currency: string | null
          description: string | null
          fiscal_year_end: string | null
          id: string
          industry: string | null
          is_active: boolean | null
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          fiscal_year_end?: string | null
          id?: string
          industry?: string | null
          is_active?: boolean | null
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          fiscal_year_end?: string | null
          id?: string
          industry?: string | null
          is_active?: boolean | null
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          company_name: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          company_name?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trial_balance_uploads: {
        Row: {
          accounting_errors: Json | null
          company_id: string | null
          company_name: string | null
          file_name: string
          file_path: string
          file_size: number
          id: string
          is_valid: boolean | null
          processed_at: string | null
          processing_result: Json | null
          status: string
          uploaded_at: string
          user_id: string | null
          validation_report: Json | null
        }
        Insert: {
          accounting_errors?: Json | null
          company_id?: string | null
          company_name?: string | null
          file_name: string
          file_path: string
          file_size: number
          id?: string
          is_valid?: boolean | null
          processed_at?: string | null
          processing_result?: Json | null
          status?: string
          uploaded_at?: string
          user_id?: string | null
          validation_report?: Json | null
        }
        Update: {
          accounting_errors?: Json | null
          company_id?: string | null
          company_name?: string | null
          file_name?: string
          file_path?: string
          file_size?: number
          id?: string
          is_valid?: boolean | null
          processed_at?: string | null
          processing_result?: Json | null
          status?: string
          uploaded_at?: string
          user_id?: string | null
          validation_report?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "trial_balance_uploads_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      account_classification:
        | "current_assets"
        | "non_current_assets"
        | "current_liabilities"
        | "non_current_liabilities"
        | "equity"
        | "revenue"
        | "cost_of_goods_sold"
        | "operating_expenses"
        | "other_income"
        | "taxes"
        | "operating_activities"
        | "investing_activities"
        | "financing_activities"
      audit_action:
        | "upload_trial_balance"
        | "process_trial_balance"
        | "correct_account_mapping"
        | "generate_disclosure_notes"
        | "export_statements"
        | "policy_compass_query"
        | "update_profile"
        | "upload_avatar"
        | "login"
        | "logout"
        | "create_company"
        | "update_company"
        | "delete_company"
        | "create_account_mapping"
        | "update_account_mapping"
        | "delete_account_mapping"
        | "validation_failed"
        | "validation_passed"
      financial_statement: "balance_sheet" | "income_statement" | "cash_flow"
      processing_status:
        | "pending"
        | "validating"
        | "mapping"
        | "calculating"
        | "valid"
        | "invalid"
        | "blocked"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_classification: [
        "current_assets",
        "non_current_assets",
        "current_liabilities",
        "non_current_liabilities",
        "equity",
        "revenue",
        "cost_of_goods_sold",
        "operating_expenses",
        "other_income",
        "taxes",
        "operating_activities",
        "investing_activities",
        "financing_activities",
      ],
      audit_action: [
        "upload_trial_balance",
        "process_trial_balance",
        "correct_account_mapping",
        "generate_disclosure_notes",
        "export_statements",
        "policy_compass_query",
        "update_profile",
        "upload_avatar",
        "login",
        "logout",
        "create_company",
        "update_company",
        "delete_company",
        "create_account_mapping",
        "update_account_mapping",
        "delete_account_mapping",
        "validation_failed",
        "validation_passed",
      ],
      financial_statement: ["balance_sheet", "income_statement", "cash_flow"],
      processing_status: [
        "pending",
        "validating",
        "mapping",
        "calculating",
        "valid",
        "invalid",
        "blocked",
      ],
    },
  },
} as const
