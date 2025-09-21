import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

console.log('Current Working Directory:', process.cwd());
console.log('\nEnvironment Variables:');
console.log('---------------------');
console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? '✓ Set' : '✗ Not Set');
console.log('VITE_STRIPE_PUBLIC_KEY:', process.env.VITE_STRIPE_PUBLIC_KEY ? '✓ Set' : '✗ Not Set');
console.log('NODE_ENV:', process.env.NODE_ENV);

// Check if the .env file exists
import fs from 'fs';
const envPath = path.resolve(process.cwd(), '.env');
console.log('\n.env file exists:', fs.existsSync(envPath) ? '✓ Yes' : '✗ No');
if (fs.existsSync(envPath)) {
    console.log('.env file location:', envPath);
} 