import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'uploads', 'videos');
    // Create directory if it doesn't exist
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
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/mp4') {
      cb(null, true);
    } else {
      cb(new Error('Only MP4 files are allowed'));
    }
  }
});

// Webhook endpoint to receive completed videos
router.post('/video-callback', upload.single('video'), async (req, res) => {
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

    // Store video metadata (you might want to use a database here)
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

    // Save metadata to a simple JSON file (replace with database in production)
    const metadataDir = path.join(process.cwd(), 'uploads', 'metadata');
    if (!fs.existsSync(metadataDir)) {
      fs.mkdirSync(metadataDir, { recursive: true });
    }
    
    const metadataFile = path.join(metadataDir, `${task_id}.json`);
    fs.writeFileSync(metadataFile, JSON.stringify(videoData, null, 2));

    console.log(`Video ${task_id} saved successfully:`, req.file.filename);

    // Respond with 200 OK to acknowledge receipt
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

// Endpoint to serve videos
router.get('/video/:taskId', (req, res) => {
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

// Endpoint to check video status
router.get('/video-status/:taskId', (req, res) => {
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

export default router;
