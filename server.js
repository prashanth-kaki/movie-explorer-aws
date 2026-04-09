const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ✅ RDS Connection Pool (credentials kept in code as requested)
const db = mysql.createPool({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb',
    waitForConnections: true,
    connectionLimit: 10
});

// ✅ AWS S3 Configuration
const s3 = new S3Client({
    region: 'us-east-1' // Uses IAM role if running on EC2
});

const BUCKET_NAME = 'movie-posters-bucket-aws';
const OMDB_API_KEY = 'aefa5fe4'; // Replace with your actual API key

// Utility function to upload poster to S3
async function uploadPosterToS3(posterUrl, title) {
    const response = await axios.get(posterUrl, {
        responseType: 'arraybuffer'
    });

    const fileName = `${title.replace(/\s+/g, '_')}_${Date.now()}.jpg`;

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: response.data,
        ContentType: 'image/jpeg'
    }));

    return `https://${BUCKET_NAME}.s3.us-east-1.amazonaws.com/${fileName}`;
}

// 🎬 Dynamic Movie Search Endpoint
app.get('/movie', async (req, res) => {
    const name = req.query.name;

    if (!name) {
        return res.status(400).json({ message: "Please provide movie name" });
    }

    try {
        // 1️⃣ Check if movie exists in RDS
        const [rows] = await db.promise().query(
            `SELECT m.*, p.poster_url
             FROM movies m
             LEFT JOIN posters p ON m.id = p.movie_id
             WHERE m.title LIKE ?`,
            [`%${name}%`]
        );

        if (rows.length > 0) {
            const movie = {
                ...rows[0],
                posters: rows
                    .filter(r => r.poster_url)
                    .map(r => r.poster_url)
            };
            return res.json(movie);
        }

        // 2️⃣ Fetch movie from OMDb API
        const apiResponse = await axios.get(
            `http://www.omdbapi.com/?t=${encodeURIComponent(name)}&apikey=${OMDB_API_KEY}`
        );

        const data = apiResponse.data;

        if (data.Response === "False") {
            return res.status(404).json({ message: "Movie not found anywhere" });
        }

        // 3️⃣ Upload poster to S3
        let s3PosterUrl = null;
        if (data.Poster && data.Poster !== "N/A") {
            s3PosterUrl = await uploadPosterToS3(data.Poster, data.Title);
        }

        // 4️⃣ Insert movie into database
        const [insertResult] = await db.promise().query(
            `INSERT INTO movies (title, description, release_year, rating, director, cast, genre, duration)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.Title,
                data.Plot,
                data.Year,
                data.imdbRating,
                data.Director,
                data.Actors,
                data.Genre,
                data.Runtime
            ]
        );

        const movieId = insertResult.insertId;

        // 5️⃣ Insert poster URL
        if (s3PosterUrl) {
            await db.promise().query(
                `INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)`,
                [movieId, s3PosterUrl]
            );
        }

        // 6️⃣ Send response
        res.status(201).json({
            id: movieId,
            title: data.Title,
            description: data.Plot,
            release_year: data.Year,
            rating: data.imdbRating,
            director: data.Director,
            cast: data.Actors,
            genre: data.Genre,
            duration: data.Runtime,
            posters: s3PosterUrl ? [s3PosterUrl] : []
        });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 🚀 Start Server
app.listen(3000, () => {
    console.log("Server running on port 3000");
});
