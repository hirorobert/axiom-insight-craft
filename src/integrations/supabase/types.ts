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
          account_code: string | null
          account_key: string | null
          account_name: string
          approved_at: string
          classification: Database["public"]["Enums"]["account_classification"]
          company_id: string | null
          confidence_source: string
          created_at: string
          id: string
          is_cash_account: boolean
          is_payroll_account: boolean
          is_retained_earnings: boolean
          line_item: string
          normal_balance: string
          normalized_account_name: string | null
          statement: Database["public"]["Enums"]["financial_statement"]
          updated_at: string
          user_id: string
        }
        Insert: {
          account_code?: string | null
          account_key?: string | null
          account_name: string
          approved_at?: string
          classification: Database["public"]["Enums"]["account_classification"]
          company_id?: string | null
          confidence_source?: string
          created_at?: string
          id?: string
          is_cash_account?: boolean
          is_payroll_account?: boolean
          is_retained_earnings?: boolean
          line_item: string
          normal_balance: string
          normalized_account_name?: string | null
          statement: Database["public"]["Enums"]["financial_statement"]
          updated_at?: string
          user_id: string
        }
        Update: {
          account_code?: string | null
          account_key?: string | null
          account_name?: string
          approved_at?: string
          classification?: Database["public"]["Enums"]["account_classification"]
          company_id?: string | null
          confidence_source?: string
          created_at?: string
          id?: string
          is_cash_account?: boolean
          is_payroll_account?: boolean
          is_retained_earnings?: boolean
          line_item?: string
          normal_balance?: string
          normalized_account_name?: string | null
          statement?: Database["public"]["Enums"]["financial_statement"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_mappings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      adjusting_journal_entries: {
        Row: {
          aje_number: string
          aje_type: string
          approved_at: string | null
          approved_by: string | null
          auto_generated: boolean
          company_id: string
          created_at: string
          created_by: string
          description: string
          id: string
          period_year: number
          source: string
          status: string
          updated_at: string
          upload_id: string
        }
        Insert: {
          aje_number: string
          aje_type: string
          approved_at?: string | null
          approved_by?: string | null
          auto_generated?: boolean
          company_id: string
          created_at?: string
          created_by: string
          description: string
          id?: string
          period_year: number
          source?: string
          status?: string
          updated_at?: string
          upload_id: string
        }
        Update: {
          aje_number?: string
          aje_type?: string
          approved_at?: string | null
          approved_by?: string | null
          auto_generated?: boolean
          company_id?: string
          created_at?: string
          created_by?: string
          description?: string
          id?: string
          period_year?: number
          source?: string
          status?: string
          updated_at?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "adjusting_journal_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "adjusting_journal_entries_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      aje_lines: {
        Row: {
          account_code: string
          account_name: string
          aje_id: string
          classification: string
          credit_tzs: number
          debit_tzs: number
          id: string
          line_number: number
          narration: string | null
        }
        Insert: {
          account_code: string
          account_name: string
          aje_id: string
          classification: string
          credit_tzs?: number
          debit_tzs?: number
          id?: string
          line_number: number
          narration?: string | null
        }
        Update: {
          account_code?: string
          account_name?: string
          aje_id?: string
          classification?: string
          credit_tzs?: number
          debit_tzs?: number
          id?: string
          line_number?: number
          narration?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "aje_lines_aje_id_fkey"
            columns: ["aje_id"]
            isOneToOne: false
            referencedRelation: "adjusting_journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "aje_lines_aje_id_fkey"
            columns: ["aje_id"]
            isOneToOne: false
            referencedRelation: "v_aje_balance_check"
            referencedColumns: ["aje_id"]
          },
        ]
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
      capital_allowances: {
        Row: {
          accounting_depreciation_tzs: number
          additions_tzs: number
          asset_description: string
          company_id: string
          cost_tzs: number
          created_at: string
          created_by: string
          disposal_proceeds_tzs: number | null
          disposals_at_tax_cost_tzs: number
          id: string
          ita_class: number
          ita_wdv_closing_tzs: number
          ita_wdv_opening_tzs: number
          notes: string | null
          period_id: string | null
          period_year: number
          source_account: string | null
          updated_at: string
          wear_tear_tzs: number
        }
        Insert: {
          accounting_depreciation_tzs?: number
          additions_tzs?: number
          asset_description: string
          company_id: string
          cost_tzs: number
          created_at?: string
          created_by: string
          disposal_proceeds_tzs?: number | null
          disposals_at_tax_cost_tzs?: number
          id?: string
          ita_class: number
          ita_wdv_closing_tzs?: number
          ita_wdv_opening_tzs?: number
          notes?: string | null
          period_id?: string | null
          period_year: number
          source_account?: string | null
          updated_at?: string
          wear_tear_tzs?: number
        }
        Update: {
          accounting_depreciation_tzs?: number
          additions_tzs?: number
          asset_description?: string
          company_id?: string
          cost_tzs?: number
          created_at?: string
          created_by?: string
          disposal_proceeds_tzs?: number | null
          disposals_at_tax_cost_tzs?: number
          id?: string
          ita_class?: number
          ita_wdv_closing_tzs?: number
          ita_wdv_opening_tzs?: number
          notes?: string | null
          period_id?: string | null
          period_year?: number
          source_account?: string | null
          updated_at?: string
          wear_tear_tzs?: number
        }
        Relationships: [
          {
            foreignKeyName: "capital_allowances_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capital_allowances_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "capital_allowances_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["current_period_id"]
          },
          {
            foreignKeyName: "capital_allowances_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["prior_period_id"]
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
          reporting_framework: string
          tin: string | null
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
          reporting_framework?: string
          tin?: string | null
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
          reporting_framework?: string
          tin?: string | null
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
      fiscal_periods: {
        Row: {
          accounting_basis: string
          active_upload_id: string | null
          company_id: string
          created_at: string
          created_by: string
          fiscal_year_end: string
          id: string
          period_label: string
          prior_period_id: string | null
          reporting_currency: string
          status: string
          updated_at: string
        }
        Insert: {
          accounting_basis?: string
          active_upload_id?: string | null
          company_id: string
          created_at?: string
          created_by: string
          fiscal_year_end: string
          id?: string
          period_label: string
          prior_period_id?: string | null
          reporting_currency?: string
          status?: string
          updated_at?: string
        }
        Update: {
          accounting_basis?: string
          active_upload_id?: string | null
          company_id?: string
          created_at?: string
          created_by?: string
          fiscal_year_end?: string
          id?: string
          period_label?: string
          prior_period_id?: string | null
          reporting_currency?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_periods_active_upload_id_fkey"
            columns: ["active_upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_periods_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_periods_prior_period_id_fkey"
            columns: ["prior_period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_periods_prior_period_id_fkey"
            columns: ["prior_period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["current_period_id"]
          },
          {
            foreignKeyName: "fiscal_periods_prior_period_id_fkey"
            columns: ["prior_period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["prior_period_id"]
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
      keyword_dictionary: {
        Row: {
          classification: Database["public"]["Enums"]["account_classification"]
          created_at: string
          id: string
          language: string
          match_type: string
          term: string
        }
        Insert: {
          classification: Database["public"]["Enums"]["account_classification"]
          created_at?: string
          id?: string
          language: string
          match_type?: string
          term: string
        }
        Update: {
          classification?: Database["public"]["Enums"]["account_classification"]
          created_at?: string
          id?: string
          language?: string
          match_type?: string
          term?: string
        }
        Relationships: []
      }
      management_inputs: {
        Row: {
          company_id: string
          created_at: string
          created_by: string
          dividends_declared_tzs: number
          id: string
          loan_repayments_tzs: number
          new_borrowings_tzs: number
          notes: string | null
          other_equity_movements_tzs: number
          period_year: number
          share_capital_issued_tzs: number
          updated_at: string
          upload_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by: string
          dividends_declared_tzs?: number
          id?: string
          loan_repayments_tzs?: number
          new_borrowings_tzs?: number
          notes?: string | null
          other_equity_movements_tzs?: number
          period_year: number
          share_capital_issued_tzs?: number
          updated_at?: string
          upload_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string
          dividends_declared_tzs?: number
          id?: string
          loan_repayments_tzs?: number
          new_borrowings_tzs?: number
          notes?: string | null
          other_equity_movements_tzs?: number
          period_year?: number
          share_capital_issued_tzs?: number
          updated_at?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "management_inputs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "management_inputs_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      period_closing_balances: {
        Row: {
          accounting_pbt_tzs: number | null
          cash_balance_tzs: number
          closing_dta_tzs: number
          closing_dtl_tzs: number
          company_id: string
          computed_at: string
          created_at: string
          cumulative_unrelieved_loss_tzs: number
          current_assets_tzs: number
          current_liabilities_tzs: number
          engine_version: string | null
          equity_tzs: number
          id: string
          net_deferred_tax_position_tzs: number
          non_current_assets_tzs: number
          non_current_liabilities_tzs: number
          other_reserves_tzs: number
          period_month: number
          period_year: number
          retained_earnings_tzs: number
          revenue_tzs: number | null
          share_capital_tzs: number
          taxable_income_tzs: number | null
          total_wear_tear_tzs: number | null
          upload_id: string | null
          wdv_class1_tzs: number
          wdv_class2_tzs: number
          wdv_class3_tzs: number
          wdv_class5_tzs: number
          wdv_class6_tzs: number
          wdv_class7_tzs: number
          wdv_class8_tzs: number
        }
        Insert: {
          accounting_pbt_tzs?: number | null
          cash_balance_tzs?: number
          closing_dta_tzs?: number
          closing_dtl_tzs?: number
          company_id: string
          computed_at?: string
          created_at?: string
          cumulative_unrelieved_loss_tzs?: number
          current_assets_tzs?: number
          current_liabilities_tzs?: number
          engine_version?: string | null
          equity_tzs?: number
          id?: string
          net_deferred_tax_position_tzs?: number
          non_current_assets_tzs?: number
          non_current_liabilities_tzs?: number
          other_reserves_tzs?: number
          period_month?: number
          period_year: number
          retained_earnings_tzs?: number
          revenue_tzs?: number | null
          share_capital_tzs?: number
          taxable_income_tzs?: number | null
          total_wear_tear_tzs?: number | null
          upload_id?: string | null
          wdv_class1_tzs?: number
          wdv_class2_tzs?: number
          wdv_class3_tzs?: number
          wdv_class5_tzs?: number
          wdv_class6_tzs?: number
          wdv_class7_tzs?: number
          wdv_class8_tzs?: number
        }
        Update: {
          accounting_pbt_tzs?: number | null
          cash_balance_tzs?: number
          closing_dta_tzs?: number
          closing_dtl_tzs?: number
          company_id?: string
          computed_at?: string
          created_at?: string
          cumulative_unrelieved_loss_tzs?: number
          current_assets_tzs?: number
          current_liabilities_tzs?: number
          engine_version?: string | null
          equity_tzs?: number
          id?: string
          net_deferred_tax_position_tzs?: number
          non_current_assets_tzs?: number
          non_current_liabilities_tzs?: number
          other_reserves_tzs?: number
          period_month?: number
          period_year?: number
          retained_earnings_tzs?: number
          revenue_tzs?: number | null
          share_capital_tzs?: number
          taxable_income_tzs?: number | null
          total_wear_tear_tzs?: number | null
          upload_id?: string | null
          wdv_class1_tzs?: number
          wdv_class2_tzs?: number
          wdv_class3_tzs?: number
          wdv_class5_tzs?: number
          wdv_class6_tzs?: number
          wdv_class7_tzs?: number
          wdv_class8_tzs?: number
        }
        Relationships: [
          {
            foreignKeyName: "period_closing_balances_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "period_closing_balances_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
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
      statement_sign_offs: {
        Row: {
          approver_firm_member_id: string | null
          approver_id: string | null
          approver_note: string | null
          approver_signed_at: string | null
          company_id: string
          created_at: string
          id: string
          locked_at: string | null
          locked_by: string | null
          period_year: number
          preparer_firm_member_id: string | null
          preparer_id: string | null
          preparer_note: string | null
          preparer_signed_at: string | null
          reviewer_firm_member_id: string | null
          reviewer_id: string | null
          reviewer_note: string | null
          reviewer_signed_at: string | null
          statements_hash: string | null
          status: string
          updated_at: string
          upload_id: string
        }
        Insert: {
          approver_firm_member_id?: string | null
          approver_id?: string | null
          approver_note?: string | null
          approver_signed_at?: string | null
          company_id: string
          created_at?: string
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          period_year: number
          preparer_firm_member_id?: string | null
          preparer_id?: string | null
          preparer_note?: string | null
          preparer_signed_at?: string | null
          reviewer_firm_member_id?: string | null
          reviewer_id?: string | null
          reviewer_note?: string | null
          reviewer_signed_at?: string | null
          statements_hash?: string | null
          status?: string
          updated_at?: string
          upload_id: string
        }
        Update: {
          approver_firm_member_id?: string | null
          approver_id?: string | null
          approver_note?: string | null
          approver_signed_at?: string | null
          company_id?: string
          created_at?: string
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          period_year?: number
          preparer_firm_member_id?: string | null
          preparer_id?: string | null
          preparer_note?: string | null
          preparer_signed_at?: string | null
          reviewer_firm_member_id?: string | null
          reviewer_id?: string | null
          reviewer_note?: string | null
          reviewer_signed_at?: string | null
          statements_hash?: string | null
          status?: string
          updated_at?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "statement_sign_offs_approver_firm_member_id_fkey"
            columns: ["approver_firm_member_id"]
            isOneToOne: false
            referencedRelation: "firm_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_sign_offs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_sign_offs_preparer_firm_member_id_fkey"
            columns: ["preparer_firm_member_id"]
            isOneToOne: false
            referencedRelation: "firm_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_sign_offs_reviewer_firm_member_id_fkey"
            columns: ["reviewer_firm_member_id"]
            isOneToOne: false
            referencedRelation: "firm_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_sign_offs_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
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
      tax_computations: {
        Row: {
          accounting_profit_before_tax_tzs: number | null
          add_backs: Json
          allowable_debt_tzs: number | null
          amt_3yr_trigger: boolean
          cit_at_30pct_tzs: number | null
          cit_gap_tzs: number | null
          company_id: string
          computation_detail: Json | null
          created_at: string
          debt_equity_ratio: number | null
          deductions: Json
          effective_tax_rate_pct: number | null
          engine_version: string
          gross_income_tzs: number | null
          id: string
          income_tax_provision_tzs: number
          interest_expense_tzs: number | null
          loss_relief_applied_tzs: number
          minimum_tax_applies: boolean
          minimum_tax_tzs: number | null
          months_overdue: number
          penalty_tzs: number
          period_id: string | null
          period_year: number
          tax_payable_tzs: number | null
          taxable_income_tzs: number | null
          thin_cap_disallowed_tzs: number
          total_add_backs_tzs: number
          total_debt_tzs: number | null
          total_deductions_tzs: number
          total_equity_tzs: number | null
          total_exposure_tzs: number | null
          total_wear_tear_tzs: number
          unrelieved_losses_bf_tzs: number
          unrelieved_losses_cf_tzs: number
          upload_id: string
          warnings: Json
        }
        Insert: {
          accounting_profit_before_tax_tzs?: number | null
          add_backs?: Json
          allowable_debt_tzs?: number | null
          amt_3yr_trigger?: boolean
          cit_at_30pct_tzs?: number | null
          cit_gap_tzs?: number | null
          company_id: string
          computation_detail?: Json | null
          created_at?: string
          debt_equity_ratio?: number | null
          deductions?: Json
          effective_tax_rate_pct?: number | null
          engine_version?: string
          gross_income_tzs?: number | null
          id?: string
          income_tax_provision_tzs?: number
          interest_expense_tzs?: number | null
          loss_relief_applied_tzs?: number
          minimum_tax_applies?: boolean
          minimum_tax_tzs?: number | null
          months_overdue?: number
          penalty_tzs?: number
          period_id?: string | null
          period_year: number
          tax_payable_tzs?: number | null
          taxable_income_tzs?: number | null
          thin_cap_disallowed_tzs?: number
          total_add_backs_tzs?: number
          total_debt_tzs?: number | null
          total_deductions_tzs?: number
          total_equity_tzs?: number | null
          total_exposure_tzs?: number | null
          total_wear_tear_tzs?: number
          unrelieved_losses_bf_tzs?: number
          unrelieved_losses_cf_tzs?: number
          upload_id: string
          warnings?: Json
        }
        Update: {
          accounting_profit_before_tax_tzs?: number | null
          add_backs?: Json
          allowable_debt_tzs?: number | null
          amt_3yr_trigger?: boolean
          cit_at_30pct_tzs?: number | null
          cit_gap_tzs?: number | null
          company_id?: string
          computation_detail?: Json | null
          created_at?: string
          debt_equity_ratio?: number | null
          deductions?: Json
          effective_tax_rate_pct?: number | null
          engine_version?: string
          gross_income_tzs?: number | null
          id?: string
          income_tax_provision_tzs?: number
          interest_expense_tzs?: number | null
          loss_relief_applied_tzs?: number
          minimum_tax_applies?: boolean
          minimum_tax_tzs?: number | null
          months_overdue?: number
          penalty_tzs?: number
          period_id?: string | null
          period_year?: number
          tax_payable_tzs?: number | null
          taxable_income_tzs?: number | null
          thin_cap_disallowed_tzs?: number
          total_add_backs_tzs?: number
          total_debt_tzs?: number | null
          total_deductions_tzs?: number
          total_equity_tzs?: number | null
          total_exposure_tzs?: number | null
          total_wear_tear_tzs?: number
          unrelieved_losses_bf_tzs?: number
          unrelieved_losses_cf_tzs?: number
          upload_id?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tax_computations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_computations_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_computations_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["current_period_id"]
          },
          {
            foreignKeyName: "tax_computations_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["prior_period_id"]
          },
          {
            foreignKeyName: "tax_computations_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_losses: {
        Row: {
          amt_3yr_trigger: boolean
          company_id: string
          consecutive_loss_years: number
          created_at: string
          created_by: string
          current_year_result_tzs: number
          id: string
          loss_utilised_tzs: number
          notes: string | null
          period_id: string | null
          period_year: number
          unrelieved_loss_bf_tzs: number
          unrelieved_loss_cf_tzs: number
          updated_at: string
          upload_id: string | null
        }
        Insert: {
          amt_3yr_trigger?: boolean
          company_id: string
          consecutive_loss_years?: number
          created_at?: string
          created_by: string
          current_year_result_tzs?: number
          id?: string
          loss_utilised_tzs?: number
          notes?: string | null
          period_id?: string | null
          period_year: number
          unrelieved_loss_bf_tzs?: number
          unrelieved_loss_cf_tzs?: number
          updated_at?: string
          upload_id?: string | null
        }
        Update: {
          amt_3yr_trigger?: boolean
          company_id?: string
          consecutive_loss_years?: number
          created_at?: string
          created_by?: string
          current_year_result_tzs?: number
          id?: string
          loss_utilised_tzs?: number
          notes?: string | null
          period_id?: string | null
          period_year?: number
          unrelieved_loss_bf_tzs?: number
          unrelieved_loss_cf_tzs?: number
          updated_at?: string
          upload_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_losses_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_losses_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_losses_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["current_period_id"]
          },
          {
            foreignKeyName: "tax_losses_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["prior_period_id"]
          },
          {
            foreignKeyName: "tax_losses_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
        ]
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
          fiscal_year_end: string | null
          id: string
          is_valid: boolean | null
          period_id: string | null
          period_year: number | null
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
          fiscal_year_end?: string | null
          id?: string
          is_valid?: boolean | null
          period_id?: string | null
          period_year?: number | null
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
          fiscal_year_end?: string | null
          id?: string
          is_valid?: boolean | null
          period_id?: string | null
          period_year?: number | null
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
          {
            foreignKeyName: "trial_balance_uploads_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trial_balance_uploads_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["current_period_id"]
          },
          {
            foreignKeyName: "trial_balance_uploads_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "v_period_pairs"
            referencedColumns: ["prior_period_id"]
          },
        ]
      }
    }
    Views: {
      v_aje_balance_check: {
        Row: {
          aje_id: string | null
          aje_number: string | null
          balanced: boolean | null
          company_id: string | null
          description: string | null
          imbalance_tzs: number | null
          period_year: number | null
          status: string | null
          total_credit_tzs: number | null
          total_debit_tzs: number | null
        }
        Relationships: [
          {
            foreignKeyName: "adjusting_journal_entries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      v_loss_history: {
        Row: {
          amt_3yr_trigger: boolean | null
          company_id: string | null
          company_name: string | null
          consecutive_loss_years: number | null
          current_year_result_tzs: number | null
          loss_utilised_tzs: number | null
          period_year: number | null
          risk_label: string | null
          unrelieved_loss_bf_tzs: number | null
          unrelieved_loss_cf_tzs: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_losses_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      v_period_pairs: {
        Row: {
          accounting_basis: string | null
          company_id: string | null
          current_label: string | null
          current_period_id: string | null
          current_upload_id: string | null
          current_year_end: string | null
          prior_label: string | null
          prior_period_id: string | null
          prior_upload_id: string | null
          prior_year_end: string | null
          reporting_currency: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_periods_active_upload_id_fkey"
            columns: ["current_upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_periods_active_upload_id_fkey"
            columns: ["prior_upload_id"]
            isOneToOne: false
            referencedRelation: "trial_balance_uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_periods_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      v_wdv_carry_forward: {
        Row: {
          asset_description: string | null
          company_id: string | null
          company_name: string | null
          current_year: number | null
          ita_class: number | null
          prior_year: number | null
          status: string | null
          wdv_closing_prior: number | null
          wdv_opening_current: number | null
        }
        Relationships: [
          {
            foreignKeyName: "capital_allowances_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      carry_forward_wdv: {
        Args: { p_company_id: string; p_from_year: number; p_to_year: number }
        Returns: {
          action: string
          asset_description: string
          ita_class: number
          wdv_closing_prior: number
          wdv_opening_new: number
        }[]
      }
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
