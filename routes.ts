import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertUserSchema } from "./schema";
import Stripe from "stripe";
import multer from 'multer';
import path from 'path';
import fs from 'fs';

// In-memory storage for tasks
const tasks = new Map();

let stripe: Stripe | null = null;

if (process.env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-05-28.basil",
  });
}

// Define Stripe price IDs
const STRIPE_PRICE_IDS = {
  starter: 'price_starter', // Replace with your actual Stripe price ID for free/starter
  pro_monthly: 'price_1RnDcORYcgsHio0AkYwJwbos', // Provided Stripe price ID for Pro monthly
  pro_yearly: 'price_1RnDcyRYcgsHio0AyFI0WPsD' // Provided Stripe price ID for Pro yearly
};

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Get billing history
  app.get("/api/billing-history", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const token = authHeader.replace("Bearer ", "");
      let firebaseUid;
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        firebaseUid = payload.user_id || payload.sub;
      } catch {
        firebaseUid = token;
      }
      
      if (!firebaseUid) {
        return res.status(401).json({ message: "Invalid token" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUid);
      if (!user || !user.stripeCustomerId) {
        return res.json({ invoices: [] });
      }

      // Fetch invoices from Stripe
      if (!stripe) {
        return res.status(500).json({ message: "Stripe not configured" });
      }
      
      const invoices = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        limit: 10,
        expand: ['data.payment_intent']
      });

      const billingHistory = invoices.data.map(invoice => ({
        id: invoice.id,
        number: invoice.number,
        date: new Date(invoice.created * 1000).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        }),
        amount: `$${(invoice.amount_paid / 100).toFixed(2)}`,
        status: invoice.status === 'paid' ? 'Paid' : 
                invoice.status === 'open' ? 'Pending' : 
                invoice.status === 'void' ? 'Void' : 'Draft',
        description: `Monthly subscription • ${invoice.number || invoice.id}`,
        downloadUrl: invoice.invoice_pdf
      }));

      res.json({ invoices: billingHistory });
    } catch (error: any) {
      console.error("Error fetching billing history:", error);
      res.status(500).json({ message: "Failed to fetch billing history" });
    }
  });

  // Get current user
  app.get("/api/user", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // For now, we'll extract the Firebase UID from the token
    // In production, you'd verify the token with Firebase Admin SDK
    const token = authHeader.replace("Bearer ", "");
    
    try {
      // Simple token parsing - in production use Firebase Admin SDK
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      const firebaseUid = payload.user_id || payload.sub;
      
      if (!firebaseUid) {
        return res.status(401).json({ message: "Invalid token" });
      }

      const user = await storage.getUserByFirebaseUid(firebaseUid);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      // Don't send password in response
      const { password, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error: any) {
      // If token parsing fails, try using the token as Firebase UID directly
      try {
        const user = await storage.getUserByFirebaseUid(token);
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }
        
        const { password, ...userWithoutPassword } = user;
        res.json(userWithoutPassword);
      } catch (innerError: any) {
        res.status(500).json({ message: "Error fetching user: " + innerError.message });
      }
    }
  });

  // Create user (registration)
  app.post("/api/users", async (req, res) => {
    try {
      const userData = insertUserSchema.parse(req.body);
      const user = await storage.createUser(userData);
      
      // Don't send password in response
      const { password, ...userWithoutPassword } = user;
      res.status(201).json(userWithoutPassword);
    } catch (error: any) {
      res.status(400).json({ message: "Error creating user: " + error.message });
    }
  });

  // Create setup intent for payment
  app.post("/api/create-setup-intent", async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ message: "Stripe not configured" });
    }

    try {
      const { planType } = req.body;
      console.log("Creating setup intent for plan:", planType);

      // Create a setup intent
      const setupIntent = await stripe.setupIntents.create({
        payment_method_types: ['card'],
        usage: 'off_session',
      });

      console.log("Setup intent created:", setupIntent.id);

      res.json({
        clientSecret: setupIntent.client_secret,
        setupIntentId: setupIntent.id
      });
    } catch (error: any) {
      console.error("Setup intent creation error:", error);
      res.status(400).json({ message: error.message });
    }
  });

  // Create subscription
  app.post("/api/create-subscription", async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ message: "Stripe not configured" });
    }

    try {
      const { planType, setupIntentId } = req.body;
      console.log("=== STRIPE SUBSCRIPTION DEBUG ===");
      console.log("Subscription request body:", req.body);
      console.log("Plan type received:", planType);
      console.log("Setup intent ID:", setupIntentId);
      console.log("Available price IDs:", STRIPE_PRICE_IDS);

      // Get the correct Stripe price ID
      const priceId = STRIPE_PRICE_IDS[planType as keyof typeof STRIPE_PRICE_IDS];
      console.log("Selected price ID:", priceId);
      
      if (!priceId) {
        console.log("ERROR: Invalid plan type - no matching price ID found");
        return res.status(400).json({ message: "Invalid plan type" });
      }

      // For free plan, skip Stripe subscription and return success
      if (planType === 'starter') {
        console.log("Free plan detected, skipping Stripe subscription");
        return res.json({ clientSecret: null });
      }

      console.log("Creating Stripe subscription with price ID:", priceId);

      let customerId: string;
      let paymentMethodId: string | undefined;

      if (setupIntentId) {
        // Get the setup intent to verify payment method
        const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
        if (!setupIntent.payment_method) {
          throw new Error("No payment method attached to setup intent");
        }
        customerId = setupIntent.customer as string;
        paymentMethodId = setupIntent.payment_method as string;
      } else {
        // For upgrades without setup intent, redirect to checkout session
        const checkoutSession = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [
            {
              price: priceId,
              quantity: 1,
            },
          ],
          mode: 'subscription',
          success_url: `${req.headers.origin}/dashboard/billing?upgrade=success`,
          cancel_url: `${req.headers.origin}/dashboard/billing?upgrade=cancelled`,
          customer_email: req.body.customerEmail,
        });

        return res.json({ 
          checkoutUrl: checkoutSession.url,
          message: "Redirect to checkout for payment"
        });
      }

      // Create the subscription
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
      });

      console.log("Subscription created successfully:", subscription.id);
      
      // Update user's plan in database based on the subscription
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const token = authHeader.replace("Bearer ", "");
          // Simple token parsing - in production use Firebase Admin SDK
          let firebaseUid;
          try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
            firebaseUid = payload.user_id || payload.sub;
          } catch {
            firebaseUid = token; // Fallback to using token as UID directly
          }
          
          if (firebaseUid) {
            const user = await storage.getUserByFirebaseUid(firebaseUid);
            if (user) {
              // Update user's plan to 'pro' and save Stripe info
              const updatedUser = await storage.updateUserStripeInfo(
                user.id, 
                customerId, 
                subscription.id
              );
              // Also update the plan to 'pro'
              await storage.updateUserPlan(user.id, "pro");
              console.log("Updated user plan to pro for user:", user.id);
            }
          }
        } catch (error) {
          console.error("Error updating user plan:", error);
          // Don't fail the subscription creation if user update fails
        }
      }
      
      console.log("=== END STRIPE SUBSCRIPTION DEBUG ===");

      res.json({
        subscriptionId: subscription.id,
        clientSecret: (subscription.latest_invoice as any).payment_intent?.client_secret,
      });
    } catch (error: any) {
      console.error("Stripe subscription creation error:", error);
      res.status(400).json({ message: error.message });
    }
  });

  // Cancel subscription
  app.post('/api/cancel-subscription', async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ message: "Stripe not configured. Please add STRIPE_SECRET_KEY." });
    }

    const firebaseUid = req.headers.authorization?.replace("Bearer ", "");
    if (!firebaseUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const user = await storage.getUserByFirebaseUid(firebaseUid);
      if (!user || !user.stripeSubscriptionId) {
        return res.status(404).json({ message: "No subscription found" });
      }

      await stripe.subscriptions.cancel(user.stripeSubscriptionId);
      await storage.updateUserPlan(user.id, "starter");

      res.json({ message: "Subscription canceled successfully" });
    } catch (error: any) {
      res.status(400).json({ message: "Error canceling subscription: " + error.message });
    }
  });

  // Chatbot integration endpoint for user-embedded bots
  app.post('/api/chat/:botId', async (req, res) => {
    const { botId } = req.params;
    const { message, sessionId } = req.body;
    
    try {
      // TODO: Fetch bot data from Firebase/database to get the bot's knowledge base
      // For now, we'll use a generic AI response since we don't have database integration here
      
      // Generate AI response using Gemini (you'll need to add your API key)
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      
      if (!GEMINI_API_KEY) {
        // Fallback response if no Gemini API key
        return res.json({
          botId,
          sessionId,
          response: `Hello! I'm an AI assistant. You said: "${message}". How can I help you further?`
        });
      }
      
      const aiPrompt = `You are a helpful AI assistant. The user said: "${message}". Please provide a helpful and conversational response.`;
      
      const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: aiPrompt
            }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 512,
          }
        })
      });
      
      if (geminiResponse.ok) {
        const data = await geminiResponse.json();
        const aiResponse = data.candidates[0]?.content?.parts[0]?.text || "I'm here to help! Could you please rephrase your question?";
        
        res.json({
          botId,
          sessionId,
          response: aiResponse
        });
      } else {
        throw new Error('Failed to get AI response');
      }
      
    } catch (error: any) {
      console.error('Error generating bot response:', error);
      // Fallback response
      res.json({
        botId,
        sessionId,
        response: `Hello! I received your message: "${message}". I'm experiencing some technical difficulties, but I'm here to help!`
      });
    }
  });

  // Tasks endpoints
  app.post("/tasks", async (req, res) => {
    try {
      const { script, search_query } = req.body;
      
      if (!script || !search_query) {
        return res.status(400).json({ message: "Script and search query are required" });
      }

      const taskId = Math.random().toString(36).substring(7);
      const task = {
        task_id: taskId,
        status: 'pending',
        script,
        search_query,
        created_at: new Date().toISOString()
      };

      tasks.set(taskId, task);

      // Simulate async processing
      setTimeout(() => {
        const updatedTask = {
          ...task,
          status: 'completed',
          video_url: 'https://example.com/sample-video.mp4' // Replace with actual video URL
        };
        tasks.set(taskId, updatedTask);
      }, 5000);

      res.status(201).json(task);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/tasks/:taskId", (req, res) => {
    const { taskId } = req.params;
    const task = tasks.get(taskId);
    
    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }
    
    res.json(task);
  });

  // Configure multer for video uploads
  const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(process.cwd(), 'uploads', 'videos');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const taskId = req.body.task_id;
      const timestamp = Date.now();
      cb(null, `${taskId}_${timestamp}.mp4`);
    }
  });

  const upload = multer({ 
    storage: multerStorage,
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'video/mp4') {
        cb(null, true);
      } else {
        cb(new Error('Only MP4 files are allowed'));
      }
    }
  });

  // Video callback endpoint
  app.post('/api/video-callback', upload.single('video'), async (req, res) => {
    try {
      console.log('Video callback received:', {
        task_id: req.body.task_id,
        status: req.body.status,
        duration: req.body.duration,
        filename: req.body.filename,
        uploadedFile: req.file?.filename
      });

      if (!req.file) {
        return res.status(400).json({ error: 'No video file received' });
      }

      const { task_id, status, duration, message } = req.body;

      // Store video metadata
      const videoData = {
        taskId: task_id,
        status,
        duration: parseFloat(duration),
        message,
        filename: req.file.filename,
        filepath: req.file.path,
        receivedAt: new Date().toISOString(),
        downloadUrl: `/api/video/${task_id}`
      };

      // Save metadata to JSON file
      const metadataDir = path.join(process.cwd(), 'uploads', 'metadata');
      if (!fs.existsSync(metadataDir)) {
        fs.mkdirSync(metadataDir, { recursive: true });
      }
      
      const metadataFile = path.join(metadataDir, `${task_id}.json`);
      fs.writeFileSync(metadataFile, JSON.stringify(videoData, null, 2));

      console.log(`Video ${task_id} saved successfully:`, req.file.filename);

      res.status(200).json({ 
        success: true, 
        message: 'Video received and stored successfully',
        downloadUrl: `/api/video/${task_id}`
      });

    } catch (error) {
      console.error('Error handling video callback:', error);
      res.status(500).json({ error: 'Failed to process video callback' });
    }
  });

  // Serve videos
  app.get('/api/video/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const metadataFile = path.join(process.cwd(), 'uploads', 'metadata', `${taskId}.json`);
      
      if (!fs.existsSync(metadataFile)) {
        return res.status(404).json({ error: 'Video not found' });
      }

      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      const videoPath = metadata.filepath;

      if (!fs.existsSync(videoPath)) {
        return res.status(404).json({ error: 'Video file not found' });
      }

      // Set proper headers for video streaming
      const stat = fs.statSync(videoPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        // Handle range requests for video streaming
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        // Send entire file
        const head = {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="generated_video_${taskId}.mp4"`
        };
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
      }

    } catch (error) {
      console.error('Error serving video:', error);
      res.status(500).json({ error: 'Failed to serve video' });
    }
  });

  // Check video status
  app.get('/api/video-status/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const metadataFile = path.join(process.cwd(), 'uploads', 'metadata', `${taskId}.json`);
      
      if (!fs.existsSync(metadataFile)) {
        return res.status(404).json({ error: 'Video not found' });
      }

      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      res.json({
        task_id: metadata.taskId,
        status: metadata.status,
        duration: metadata.duration,
        downloadUrl: metadata.downloadUrl,
        receivedAt: metadata.receivedAt
      });

    } catch (error) {
      console.error('Error checking video status:', error);
      res.status(500).json({ error: 'Failed to check video status' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
