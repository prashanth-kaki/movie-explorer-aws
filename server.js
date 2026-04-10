const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ✅ RDS Connection Pool
const db = mysql.createPool({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb',
    waitForConnections: true,
    connectionLimit: 10
});

// ✅ AWS S3 Configuration (uses IAM role on EC2)
const s3 = new S3Client({ region: 'us-east-1' });

const BUCKET_NAME = 'movie-posters-bucket-aws';
const TMDB_API_KEY = 'de3829d7d755bdec0ba42d9ba27990e';

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

// 🎬 Movie Search Endpoint (TMDb Only)
app.get('/movie', async (req, res) => {
    const name = req.query.name;

    if (!name) {
        return res.status(400).json({ message: "Please provide movie name" });
    }

    try {
        // 1️⃣ Check if movie exists in RDS
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

        // 2️⃣ Search movie in TMDb
        const searchRes = await axios.get(
            `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(name)}`
        );

        if (!searchRes.data.results.length) {
            return res.status(404).json({ message: "Movie not found" });
        }

        const movieId = searchRes.data.results[0].id;

        // 3️⃣ Fetch movie details with credits and images
        const detailsRes = await axios.get(
            `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=credits,images`
        );

        const movieData = detailsRes.data;

        // Extract director
        const director = movieData.credits.crew.find(
            person => person.job === "Director"
        )?.name || "N/A";

        // Extract top cast
        const cast = movieData.credits.cast
            .slice(0, 5)
            .map(actor => actor.name)
            .join(', ');

        // Extract genres
        const genre = movieData.genres.map(g => g.name).join(', ');

        // 4️⃣ Insert movie into RDS
        const [insertResult] = await db.promise().query(
            `INSERT INTO movies 
            (title, description, release_year, rating, director, \`cast\`, genre, duration)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                movieData.title,
                movieData.overview,
                movieData.release_date?.split('-')[0],
                movieData.vote_average,
                director,
                cast,
                genre,
                `${movieData.runtime} min`
            ]
        );

        const newMovieId = insertResult.insertId;

        // 5️⃣ Get up to 4 posters from TMDb
        const posterPaths = movieData.images.posters.slice(0, 4);

        const s3PosterUrls = [];

        for (let i = 0; i < posterPaths.length; i++) {
            const imageUrl = `https://image.tmdb.org/t/p/w500${posterPaths[i].file_path}`;
            const s3Url = await uploadPosterToS3(imageUrl, movieData.title, i);
            s3PosterUrls.push(s3Url);

            await db.promise().query(
                "INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)",
                [newMovieId, s3Url]
            );
        }

        // 6️⃣ Send response
        res.status(201).json({
            id: newMovieId,
            title: movieData.title,
            description: movieData.overview,
            release_year: movieData.release_date?.split('-')[0],
            rating: movieData.vote_average,
            director,
            cast,
            genre,
            duration: `${movieData.runtime} min`,
            posters: s3PosterUrls
        });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 🚀 Start Server
app.listen(3000, '0.0.0.0', () => {
    console.log("Server running on port 3000");
});
