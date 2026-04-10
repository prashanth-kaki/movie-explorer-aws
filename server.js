const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* =========================
   ✅ RDS DATABASE CONFIG
   ========================= */
const db = mysql.createPool({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb',
    waitForConnections: true,
    connectionLimit: 10
});

/* =========================
   ✅ TMDb API CONFIG
   ========================= */
const TMDB_API_KEY = 'de3829d7d755bdec0ba42d9ba27990e'; // Your TMDb v3 API Key
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

/* =========================
   ✅ AWS S3 CONFIG
   ========================= */
const s3 = new S3Client({
    region: 'us-east-1' // Uses IAM Role attached to EC2
});

const BUCKET_NAME = 'movie-posters-bucket-aws';

/* =========================
   ✅ Upload Poster to S3
   ========================= */
async function uploadPosterToS3(posterPath, title, index) {
    const imageUrl = `${TMDB_IMAGE_BASE}${posterPath}`;
    const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer'
    });

    const fileName = `${title.replace(/\s+/g, '_')}_${index}.jpg`;

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: response.data,
        ContentType: 'image/jpeg'
    }));

    return `https://${BUCKET_NAME}.s3.us-east-1.amazonaws.com/${fileName}`;
}

/* =========================
   🎬 GET MOVIE ENDPOINT
   ========================= */
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
                id: rows[0].id,
                title: rows[0].title,
                description: rows[0].description,
                release_year: rows[0].release_year,
                rating: rows[0].rating,
                director: rows[0].director,
                cast: rows[0].cast,
                genre: rows[0].genre,
                duration: rows[0].duration,
                posters: rows
                    .filter(r => r.poster_url)
                    .map(r => r.poster_url)
            };
            return res.json(movie);
        }

        // 2️⃣ Search movie in TMDb
        const searchRes = await axios.get(`${TMDB_BASE_URL}/search/movie`, {
            params: {
                api_key: TMDB_API_KEY,
                query: name
            }
        });

        if (!searchRes.data.results.length) {
            return res.status(404).json({ message: "Movie not found" });
        }

        const movieId = searchRes.data.results[0].id;

        // 3️⃣ Fetch movie details with images and credits
        const detailsRes = await axios.get(`${TMDB_BASE_URL}/movie/${movieId}`, {
            params: {
                api_key: TMDB_API_KEY,
                append_to_response: 'credits,images'
            }
        });

        const movie = detailsRes.data;

        // Extract required details
        const director = movie.credits.crew.find(c => c.job === 'Director')?.name || 'N/A';
        const cast = movie.credits.cast.slice(0, 5).map(c => c.name).join(', ');
        const genre = movie.genres.map(g => g.name).join(', ');
        const duration = movie.runtime ? `${movie.runtime} min` : 'N/A';
        const releaseYear = movie.release_date ? movie.release_date.split('-')[0] : 'N/A';
        const rating = movie.vote_average || 'N/A';

        // 4️⃣ Get up to 4 posters and upload to S3
        const posters = movie.images.posters.slice(0, 4);
        const posterUrls = [];

        for (let i = 0; i < posters.length; i++) {
            const url = await uploadPosterToS3(posters[i].file_path, movie.title, i + 1);
            posterUrls.push(url);
        }

        // 5️⃣ Insert movie into database
        const [insertResult] = await db.promise().query(
            `INSERT INTO movies (title, description, release_year, rating, director, cast, genre, duration)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                movie.title,
                movie.overview,
                releaseYear,
                rating,
                director,
                cast,
                genre,
                duration
            ]
        );

        const newMovieId = insertResult.insertId;

        // 6️⃣ Insert poster URLs into posters table
        for (const url of posterUrls) {
            await db.promise().query(
                `INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)`,
                [newMovieId, url]
            );
        }

        // 7️⃣ Send response to frontend
        res.status(201).json({
            id: newMovieId,
            title: movie.title,
            description: movie.overview,
            release_year: releaseYear,
            rating: rating,
            director: director,
            cast: cast,
            genre: genre,
            duration: duration,
            posters: posterUrls
        });

    } catch (error) {
        console.error("Server Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Internal server error" });
    }
});

/* =========================
   🚀 START SERVER
   ========================= */
app.listen(3000, () => {
    console.log("Server running on port 3000");
});
