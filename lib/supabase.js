import { createClient } from '@supabase/supabase-js';

// Vercel will securely inject these variables at runtime
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false } // Serverless environments shouldn't persist sessions locally
});