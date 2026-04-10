const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// RDS Connection Pool
const db = mysql.createPool({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb',
    waitForConnections: true,
    connectionLimit: 10
});

// AWS S3 Configuration (uses IAM role on EC2)
const s3 = new S3Client({ region: 'us-east-1' });

const BUCKET_NAME = 'movie-posters-bucket-aws';
const OMDB_API_KEY = 'aefa5fe'; // Your working OMDb key
const TMDB_API_KEY = 'de3829d7d755bdec0ba42d9ba27990e'; // TMDb API key

// 🔹 Upload image to S3
async function uploadPosterToS3(imageUrl, title, index) {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const fileName = `${title.replace(/\s+/g, '_')}_${Date.now()}_${index}.jpg`;

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: response.data,
        ContentType: 'image/jpeg'
    }));

    return `https://${BUCKET_NAME}.s3.us-east-1.amazonaws.com/${fileName}`;
}

//  Fetch multiple posters from TMDb
async function fetchTMDBPosters(title) {
    try {
        // Search for the movie
        const searchRes = await axios.get(
            `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`
        );

        if (!searchRes.data.results.length) return [];

        const movieId = searchRes.data.results[0].id;

        // Fetch posters
        const imagesRes = await axios.get(
            `https://api.themoviedb.org/3/movie/${movieId}/images?api_key=${TMDB_API_KEY}`
        );

        return imagesRes.data.posters
            .slice(0, 4)
            .map(poster => `https://image.tmdb.org/t/p/w500${poster.file_path}`);
    } catch (error) {
        console.error("TMDb Error:", error.message);
        return [];
    }
}

// Dynamic Movie Search Endpoint
app.get('/movie', async (req, res) => {
    const name = req.query.name;

    if (!name) {
        return res.status(400).json({ message: "Please provide movie name" });
    }

    try {
        // 1️⃣ Check RDS first
        const [movieRows] = await db.promise().query(
            "SELECT * FROM movies WHERE LOWER(title) LIKE LOWER(?) LIMIT 1",
            [`%${name}%`]
        );

        if (movieRows.length > 0) {
            const movie = movieRows[0];

            const [posterRows] = await db.promise().query(
                "SELECT poster_url FROM posters WHERE movie_id = ? LIMIT 4",
                [movie.id]
            );

            return res.json({
                ...movie,
                posters: posterRows.map(p => p.poster_url)
            });
        }

        // 2️⃣ Fetch movie details from OMDb
        const omdbRes = await axios.get(
            `http://www.omdbapi.com/?t=${encodeURIComponent(name)}&apikey=${OMDB_API_KEY}`
        );

        const data = omdbRes.data;

        if (data.Response === "False") {
            return res.status(404).json({ message: "Movie not found" });
        }

        // 3️⃣ Insert movie into RDS
        const [insertResult] = await db.promise().query(
            `INSERT INTO movies 
            (title, description, release_year, rating, director, \`cast\`, genre, duration)
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

        // 4️⃣ Fetch multiple posters from TMDb
        const tmdbPosters = await fetchTMDBPosters(data.Title);

        // 5️⃣ Upload posters to S3 and store in DB
        const s3PosterUrls = [];
        for (let i = 0; i < tmdbPosters.length; i++) {
            const s3Url = await uploadPosterToS3(tmdbPosters[i], data.Title, i);
            s3PosterUrls.push(s3Url);

            await db.promise().query(
                "INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)",
                [movieId, s3Url]
            );
        }

        // Fallback to OMDb poster if TMDb returns none
        if (s3PosterUrls.length === 0 && data.Poster !== "N/A") {
            const s3Url = await uploadPosterToS3(data.Poster, data.Title, 0);
            s3PosterUrls.push(s3Url);

            await db.promise().query(
                "INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)",
                [movieId, s3Url]
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
            posters: s3PosterUrls.slice(0, 4)
        });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).json({ error: "Internal server error" });
    }
});

//  Start Server
app.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
});
