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
          user_id?: string
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
          is_payroll_account: boolean
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
          is_payroll_account?: boolean
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
          is_payroll_account?: boolean
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
          user_id?: string
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
      canonical_financial_records: {
        Row: {
          adapter_confidence: number
          amount_tzs: number
          batch_id: string
          canonical_date: string
          company_id: string
          counterparty_name: string | null
          counterparty_tin: string | null
          id: string
          import_batch_id: string
          imported_at: string
          imported_by: string
          ingestion_contract_version: string
          normalized_hash: string
          payload_hash: string
          period_month: number
          period_year: number
          provider_name: string
          raw_payload: Json
          record_type: string
          requires_secondary_review: boolean
          source_file_reference: string | null
          source_identifier: string | null
          source_type: string
          tin_absent: boolean
          vat_amount_tzs: number
        }
        Insert: {
          adapter_confidence?: number
          amount_tzs: number
          batch_id: string
          canonical_date: string
          company_id: string
          counterparty_name?: string | null
          counterparty_tin?: string | null
          id?: string
          import_batch_id: string
          imported_at?: string
          imported_by: string
          ingestion_contract_version: string
          normalized_hash: string
          payload_hash: string
          period_month: number
          period_year: number
          provider_name: string
          raw_payload: Json
          record_type: string
          requires_secondary_review?: boolean
          source_file_reference?: string | null
          source_identifier?: string | null
          source_type: string
          tin_absent?: boolean
          vat_amount_tzs?: number
        }
        Update: {
          adapter_confidence?: number
          amount_tzs?: number
          batch_id?: string
          canonical_date?: string
          company_id?: string
          counterparty_name?: string | null
          counterparty_tin?: string | null
          id?: string
          import_batch_id?: string
          imported_at?: string
          imported_by?: string
          ingestion_contract_version?: string
          normalized_hash?: string
          payload_hash?: string
          period_month?: number
          period_year?: number
          provider_name?: string
          raw_payload?: Json
          record_type?: string
          requires_secondary_review?: boolean
          source_file_reference?: string | null
          source_identifier?: string | null
          source_type?: string
          tin_absent?: boolean
          vat_amount_tzs?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_canonical_batch"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "ingestion_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_canonical_company"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
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
      efdms_records: {
        Row: {
          amount_tzs: number
          company_id: string
          counterparty_name: string | null
          counterparty_tin: string | null
          created_at: string
          efd_device_id: string | null
          efdms_transaction_id: string
          id: string
          ingested_by: string | null
          period_month: number
          period_year: number
          raw_payload: Json | null
          record_type: string
          source_batch_id: string | null
          transaction_date: string
          vat_amount_tzs: number
        }
        Insert: {
          amount_tzs: number
          company_id: string
          counterparty_name?: string | null
          counterparty_tin?: string | null
          created_at?: string
          efd_device_id?: string | null
          efdms_transaction_id: string
          id?: string
          ingested_by?: string | null
          period_month: number
          period_year: number
          raw_payload?: Json | null
          record_type: string
          source_batch_id?: string | null
          transaction_date: string
          vat_amount_tzs?: number
        }
        Update: {
          amount_tzs?: number
          company_id?: string
          counterparty_name?: string | null
          counterparty_tin?: string | null
          created_at?: string
          efd_device_id?: string | null
          efdms_transaction_id?: string
          id?: string
          ingested_by?: string | null
          period_month?: number
          period_year?: number
          raw_payload?: Json | null
          record_type?: string
          source_batch_id?: string | null
          transaction_date?: string
          vat_amount_tzs?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_efdms_company"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_requests: {
        Row: {
          created_at: string
          created_by: string
          current_step: number
          documents_requested: string[]
          finding_id: string
          id: string
          notes: string | null
          step1_requested_at: string | null
          step1_requested_by: string | null
          step2_last_reminder_at: string | null
          step2_reminder_count: number
          step3_received_at: string | null
          step3_received_by: string | null
          step4_review_started_at: string | null
          step4_reviewed_at: string | null
          step4_reviewed_by: string | null
          step5_signed_by: string | null
          step5_signoff_at: string | null
          step6_submission_ref: string | null
          step6_submitted_at: string | null
          step6_submitted_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          current_step?: number
          documents_requested?: string[]
          finding_id: string
          id?: string
          notes?: string | null
          step1_requested_at?: string | null
          step1_requested_by?: string | null
          step2_last_reminder_at?: string | null
          step2_reminder_count?: number
          step3_received_at?: string | null
          step3_received_by?: string | null
          step4_review_started_at?: string | null
          step4_reviewed_at?: string | null
          step4_reviewed_by?: string | null
          step5_signed_by?: string | null
          step5_signoff_at?: string | null
          step6_submission_ref?: string | null
          step6_submitted_at?: string | null
          step6_submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          current_step?: number
          documents_requested?: string[]
          finding_id?: string
          id?: string
          notes?: string | null
          step1_requested_at?: string | null
          step1_requested_by?: string | null
          step2_last_reminder_at?: string | null
          step2_reminder_count?: number
          step3_received_at?: string | null
          step3_received_by?: string | null
          step4_review_started_at?: string | null
          step4_reviewed_at?: string | null
          step4_reviewed_by?: string | null
          step5_signed_by?: string | null
          step5_signoff_at?: string | null
          step6_submission_ref?: string | null
          step6_submitted_at?: string | null
          step6_submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_evidence_finding"
            columns: ["finding_id"]
            isOneToOne: true
            referencedRelation: "findings"
            referencedColumns: ["id"]
          },
        ]
      }
      findings: {
        Row: {
          assigned_to_user_id: string | null
          base_amount_tzs: number | null
          company_id: string
          comparison_amount_tzs: number | null
          computed_obligation_tzs: number | null
          created_at: string
          created_by: string
          engine_run_id: string | null
          exposure_amount_tzs: number
          finding_category: string | null
          finding_type: string
          id: string
          interest_amount_tzs: number | null
          penalty_amount_tzs: number | null
          period_end: string
          period_start: string
          related_finding_ids: string[] | null
          response_pack_ready: boolean
          source_detail: Json
          status: string
          statute_reference: string | null
          statutory_rule_id: string | null
          title: string
          tra_notice_date: string | null
          tra_notice_ref: string | null
          updated_at: string
          upload_id: string | null
        }
        Insert: {
          assigned_to_user_id?: string | null
          base_amount_tzs?: number | null
          company_id: string
          comparison_amount_tzs?: number | null
          computed_obligation_tzs?: number | null
          created_at?: string
          created_by?: string
          engine_run_id?: string | null
          exposure_amount_tzs: number
          finding_category?: string | null
          finding_type: string
          id?: string
          interest_amount_tzs?: number | null
          penalty_amount_tzs?: number | null
          period_end: string
          period_start: string
          related_finding_ids?: string[] | null
          response_pack_ready?: boolean
          source_detail?: Json
          status?: string
          statute_reference?: string | null
          statutory_rule_id?: string | null
          title: string
          tra_notice_date?: string | null
          tra_notice_ref?: string | null
          updated_at?: string
          upload_id?: string | null
        }
        Update: {
          assigned_to_user_id?: string | null
          base_amount_tzs?: number | null
          company_id?: string
          comparison_amount_tzs?: number | null
          computed_obligation_tzs?: number | null
          created_at?: string
          created_by?: string
          engine_run_id?: string | null
          exposure_amount_tzs?: number
          finding_category?: string | null
          finding_type?: string
          id?: string
          interest_amount_tzs?: number | null
          penalty_amount_tzs?: number | null
          period_end?: string
          period_start?: string
          related_finding_ids?: string[] | null
          response_pack_ready?: boolean
          source_detail?: Json
          status?: string
          statute_reference?: string | null
          statutory_rule_id?: string | null
          title?: string
          tra_notice_date?: string | null
          tra_notice_ref?: string | null
          updated_at?: string
          upload_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_findings_company"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_findings_statutory_rule"
            columns: ["statutory_rule_id"]
            isOneToOne: false
            referencedRelation: "statutory_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_findings_upload"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      firm_members: {
        Row: {
          accepted_at: string | null
          company_id: string
          created_at: string
          id: string
          invited_by: string | null
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          company_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          company_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_firm_member_company"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      ingestion_batches: {
        Row: {
          company_id: string
          completed_at: string | null
          error_count: number | null
          error_summary: Json | null
          id: string
          import_batch_id: string
          imported_at: string
          imported_by: string
          ingestion_contract_version: string
          inserted_count: number | null
          provider_name: string
          record_count: number
          skipped_count: number | null
          source_file_reference: string | null
          source_type: string
          status: string
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          error_count?: number | null
          error_summary?: Json | null
          id?: string
          import_batch_id: string
          imported_at?: string
          imported_by: string
          ingestion_contract_version?: string
          inserted_count?: number | null
          provider_name: string
          record_count: number
          skipped_count?: number | null
          source_file_reference?: string | null
          source_type: string
          status?: string
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          error_count?: number | null
          error_summary?: Json | null
          id?: string
          import_batch_id?: string
          imported_at?: string
          imported_by?: string
          ingestion_contract_version?: string
          inserted_count?: number | null
          provider_name?: string
          record_count?: number
          skipped_count?: number | null
          source_file_reference?: string | null
          source_type?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_batch_company"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
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
      statutory_rules: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          flat_tax_tzs: number | null
          id: string
          industry_pack: string | null
          jurisdiction: string
          notes: string | null
          obligation: string
          penalty_rate_pct: number | null
          rate_is_threshold: boolean
          rate_pct: number | null
          statute: string
          threshold_amount: number | null
          trigger_account_classification:
            | Database["public"]["Enums"]["account_classification"]
            | null
          trigger_category: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          created_at?: string
          effective_from: string
          effective_to?: string | null
          flat_tax_tzs?: number | null
          id?: string
          industry_pack?: string | null
          jurisdiction?: string
          notes?: string | null
          obligation: string
          penalty_rate_pct?: number | null
          rate_is_threshold?: boolean
          rate_pct?: number | null
          statute: string
          threshold_amount?: number | null
          trigger_account_classification?:
            | Database["public"]["Enums"]["account_classification"]
            | null
          trigger_category: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          flat_tax_tzs?: number | null
          id?: string
          industry_pack?: string | null
          jurisdiction?: string
          notes?: string | null
          obligation?: string
          penalty_rate_pct?: number | null
          rate_is_threshold?: boolean
          rate_pct?: number | null
          statute?: string
          threshold_amount?: number | null
          trigger_account_classification?:
            | Database["public"]["Enums"]["account_classification"]
            | null
          trigger_category?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      tax_payments: {
        Row: {
          amount_paid_tzs: number
          company_id: string
          created_at: string
          created_by: string
          id: string
          notes: string | null
          payment_date: string
          payment_reference: string | null
          payment_source: string
          period_month: number
          period_year: number
          tax_category: string
          updated_at: string
        }
        Insert: {
          amount_paid_tzs: number
          company_id: string
          created_at?: string
          created_by: string
          id?: string
          notes?: string | null
          payment_date: string
          payment_reference?: string | null
          payment_source?: string
          period_month: number
          period_year: number
          tax_category: string
          updated_at?: string
        }
        Update: {
          amount_paid_tzs?: number
          company_id?: string
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          payment_date?: string
          payment_reference?: string | null
          payment_source?: string
          period_month?: number
          period_year?: number
          tax_category?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_payments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
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
      get_member_company_ids: { Args: never; Returns: string[] }
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
        | "canonical_ingestion_started"
        | "canonical_ingestion_completed"
        | "canonical_ingestion_failed"
        | "reconciliation_run"
        | "finding_generated"
        | "finding_status_changed"
        | "finding_disputed"
        | "finding_resolved"
        | "evidence_requested"
        | "evidence_received"
        | "response_pack_generated"
        | "statutory_rule_verified"
        | "firm_member_invited"
        | "firm_member_accepted"
        | "firm_member_removed"
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
        "canonical_ingestion_started",
        "canonical_ingestion_completed",
        "canonical_ingestion_failed",
        "reconciliation_run",
        "finding_generated",
        "finding_status_changed",
        "finding_disputed",
        "finding_resolved",
        "evidence_requested",
        "evidence_received",
        "response_pack_generated",
        "statutory_rule_verified",
        "firm_member_invited",
        "firm_member_accepted",
        "firm_member_removed",
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
