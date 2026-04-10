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
const TMDB_API_KEY = 'de3829d7d755bdec0ba42d9ba27990e';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

/* =========================
   ✅ AWS S3 CONFIG
   ========================= */
const s3 = new S3Client({
    region: 'us-east-1',
    credentials: {
        accessKeyId: 'YOUR_AWS_ACCESS_KEY_ID',
        secretAccessKey: 'YOUR_AWS_SECRET_ACCESS_KEY'
    }
});

const BUCKET_NAME = 'movie-posters-bucket-aws';

/* =========================
   ✅ Upload Poster to S3
   ========================= */
async function uploadPosterToS3(posterPath, title, index) {
    try {
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
    } catch (error) {
        console.error("Error uploading to S3:", error.message);
        return null;
    }
}

/* =========================
   🎬 GET MOVIE ENDPOINT
   ========================= */
app.get('/movie', async (req, res) => {
    const name = req.query.name?.trim();

    if (!name) {
        return res.status(400).json({
            success: false,
            message: "Please provide a movie name",
            posters: []
        });
    }

    try {
        console.log(`Searching for movie: ${name}`);

        /* 1️⃣ Check if movie exists in RDS */
        const [rows] = await db.promise().query(
            `SELECT m.*, p.poster_url
             FROM movies m
             LEFT JOIN posters p ON m.id = p.movie_id
             WHERE LOWER(m.title) LIKE LOWER(?)`,
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

            console.log(`Movie found in database: ${movie.title}`);
            return res.status(200).json(movie);
        }

        console.log(`Movie not found in DB. Fetching from TMDb...`);

        /* 2️⃣ Search movie in TMDb */
        const searchRes = await axios.get(`${TMDB_BASE_URL}/search/movie`, {
            params: {
                api_key: TMDB_API_KEY,
                query: name
            }
        });

        if (!searchRes.data.results.length) {
            return res.status(404).json({
                success: false,
                message: "Movie not found",
                posters: []
            });
        }

        const movieId = searchRes.data.results[0].id;

        /* 3️⃣ Fetch movie details with images and credits */
        const detailsRes = await axios.get(`${TMDB_BASE_URL}/movie/${movieId}`, {
            params: {
                api_key: TMDB_API_KEY,
                append_to_response: 'credits,images'
            }
        });

        const movieData = detailsRes.data;

        const director = movieData.credits.crew.find(c => c.job === 'Director')?.name || 'N/A';
        const cast = movieData.credits.cast.slice(0, 5).map(c => c.name).join(', ');
        const genre = movieData.genres.map(g => g.name).join(', ');
        const duration = movieData.runtime ? `${movieData.runtime} min` : 'N/A';
        const releaseYear = movieData.release_date
            ? movieData.release_date.split('-')[0]
            : 'N/A';
        const rating = movieData.vote_average || 'N/A';

        /* 4️⃣ Upload up to 4 posters to S3 */
        const posters = movieData.images?.posters?.slice(0, 4) || [];
        const posterUrls = [];

        for (let i = 0; i < posters.length; i++) {
            const url = await uploadPosterToS3(
                posters[i].file_path,
                movieData.title,
                i + 1
            );
            if (url) posterUrls.push(url);
        }

        /* 5️⃣ Prevent duplicate movie entries */
        const [existingMovie] = await db.promise().query(
            `SELECT id FROM movies WHERE LOWER(title) = LOWER(?)`,
            [movieData.title]
        );

        let movieIdInDb;

        if (existingMovie.length > 0) {
            movieIdInDb = existingMovie[0].id;
        } else {
            const [insertResult] = await db.promise().query(
                `INSERT INTO movies 
                (title, description, release_year, rating, director, cast, genre, duration)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    movieData.title,
                    movieData.overview,
                    releaseYear,
                    rating,
                    director,
                    cast,
                    genre,
                    duration
                ]
            );
            movieIdInDb = insertResult.insertId;
        }

        /* 6️⃣ Insert poster URLs */
        for (const url of posterUrls) {
            await db.promise().query(
                `INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)`,
                [movieIdInDb, url]
            );
        }

        /* 7️⃣ Send response to frontend */
        return res.status(200).json({
            id: movieIdInDb,
            title: movieData.title,
            description: movieData.overview,
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
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            posters: []
        });
    }
});

/* =========================
   🚀 START SERVER
   ========================= */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
