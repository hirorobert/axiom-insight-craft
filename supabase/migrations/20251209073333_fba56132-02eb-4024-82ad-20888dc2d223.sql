-- Create table for storing account mapping corrections
CREATE TABLE public.account_corrections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  upload_id UUID NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  account_code TEXT NOT NULL,
  original_category TEXT,
  original_subcategory TEXT,
  corrected_category TEXT NOT NULL,
  corrected_subcategory TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(upload_id, account_code)
);

-- Enable Row Level Security
ALTER TABLE public.account_corrections ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own corrections" 
ON public.account_corrections 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own corrections" 
ON public.account_corrections 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own corrections" 
ON public.account_corrections 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own corrections" 
ON public.account_corrections 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_account_corrections_updated_at
BEFORE UPDATE ON public.account_corrections
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();