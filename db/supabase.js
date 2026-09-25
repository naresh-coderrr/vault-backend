'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const connectionString = process.env.DATABASE_URL;

let supabase = null;
let pgPool = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('⚡ Connected to Supabase via JavaScript Client API');
}

if (connectionString && connectionString.includes('supabase')) {
  pgPool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });
  console.log('🐘 Connected to Supabase PostgreSQL Database Pool');
}

module.exports = {
  supabase,
  pgPool,
  isSupabaseConfigured: () => Boolean(supabase || pgPool)
};
