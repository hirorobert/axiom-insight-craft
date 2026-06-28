import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2 } from "lucide-react";

interface Company {
  id: string;
  name: string;
  code: string | null;
}

interface CompanySelectorProps {
  value: string | null;
  onChange: (companyId: string | null) => void;
  placeholder?: string;
  className?: string;
}

export const CompanySelector = ({
  value,
  onChange,
  placeholder = "Select company",
  className,
}: CompanySelectorProps) => {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    const fetchCompanies = async () => {
      if (!user) return;

      const { data, error } = await supabase
        .from("companies")
        .select("id, name, code")
        .eq("is_active", true)
        .order("name");

      if (!error && data) {
        setCompanies(data);
      }
      setLoading(false);
    };

    fetchCompanies();
  }, [user]);

  if (loading) {
    return (
      <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}>
        <Building2 className="w-4 h-4" />
        Loading...
      </div>
    );
  }

  if (companies.length === 0) {
    return null;
  }

  return (
    <Select
      value={value || "all"}
      onValueChange={(val) => onChange(val === "all" ? null : val)}
    >
      <SelectTrigger className={className}>
        <div className="flex items-center gap-2">
          <Building2 className="w-4 h-4 text-primary" />
          <SelectValue placeholder={placeholder} />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">
          <span className="font-medium">All Companies</span>
        </SelectItem>
        {companies.map((company) => (
          <SelectItem key={company.id} value={company.id}>
            {company.name}
            {company.code && <span className="text-muted-foreground ml-2">({company.code})</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
