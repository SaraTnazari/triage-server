import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';


console.log("🚀 STARTING THE ENGINE...");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function simpleTest() {
  console.log("📡 Sending test data to Supabase...");
  
  const testData = {
    id: uuidv4(),
    sender: "Test Pilot",
    summary: "The engine is officially working!",
    url: "https://apple.com/" + Math.random()
  };

  const { error } = await supabase.from('pending_actions').insert([testData]);

  if (error) {
    console.log("❌ DB Error:", error.message);
  } else {
    console.log("✅ SUCCESS! Check your Supabase dashboard now.");
  }
}

simpleTest();
