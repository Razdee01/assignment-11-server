const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri =
  "mongodb+srv://contestHub-db:QBYR33eiAyOcD3Sp@cluster0.xujbby0.mongodb.net/?appName=Cluster0";


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("contestHub-db");
    const contestsCollection = db.collection("contests");

    app.get("/popular-contests", async (req, res) => {
      try {
        const contests = await contestsCollection
          .find()
          .sort({
            participants: -1,
          })
          .limit(5)
          .toArray(); 

        res.send(contests);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to load popular contests" });
      }
    });
    app.get("/all-contests", async (req, res) => {
     
        const contests = await contestsCollection.find().toArray(); 
        res.send(contests);
    });
    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const contest = await contestsCollection.findOne({ _id: new ObjectId(id) }); 
      res.send(contest);
    });
    
  
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
   
  }
}
run().catch(console.dir);


app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

