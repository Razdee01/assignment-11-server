require("dotenv").config();

const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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
    const registrationsCollection = db.collection("registrations");

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
      
        res.status(500).send({ message: "Failed to load popular contests" });
      }
    });
    
    app.get("/all-contests", async (req, res) => {
      const { search } = req.query;
      let filter = {};

      if (search && search !== "All") {
        // Case-insensitive regex match
        filter.contentType = { $regex: `^${search}$`, $options: "i" };
      }

      try {
        const contests = await contestsCollection.find(filter).toArray();
        res.status(200).send(contests);
      } catch (err) {
        
        res.status(500).send({ message: "Error fetching contests" });
      }
    });
    
   app.post("/create-checkout-session", async (req, res) => {
      const paymentData = req.body;
    
    

      const session = await stripe.checkout.sessions.create({
        success_url: "https://example.com/success",
        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: paymentData.contestName,
                description: paymentData.description,
                images: [paymentData.bannerImage],
              },
              unit_amount: paymentData.amount * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentData.userEmail,
        mode: "payment",
        metadata: {
          contestId: paymentData.contestId,
          contestName: paymentData.contestName,
          bannerImage: paymentData.bannerImage, // ✅ ADD
          description: paymentData.description, // ✅ ADD
          userId: paymentData.userId,
          userName: paymentData.userName,
          userEmail: paymentData.userEmail,
          userPhoto: paymentData.userPhoto,
        },

        success_url:
          "http://localhost:5173/payment-success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: `http://localhost:5173/contests/${paymentData.contestId}`,
      });
      res.send({ url: session.url });
      
    });
    app.post("/payment-success", async (req, res) => {
     
        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

      const contest= await contestsCollection.findOne({
        _id:new ObjectId( session.metadata.contestId)
      })
      const registration= await registrationsCollection.findOne({
        transactionId: session.payment_intent
      })

        if (session.payment_status === "paid" && contest && !registration) {
          const registrationInfo = {
            contestId: session.metadata.contestId,
            contestName: session.metadata.contestName,
            bannerImage: session.metadata.bannerImage,
            status:"pending",
            description: session.metadata.description,
            amount: session.amount_total / 100,
            userId: session.metadata.userId,
            userName: session.metadata.userName,
            userEmail: session.metadata.userEmail,
            userPhoto: session.metadata.userPhoto,
            transactionId: session.payment_intent,
          };

           const result=  await registrationsCollection.insertOne(registrationInfo);
           await contestsCollection.updateOne(
            { _id: new ObjectId(session.metadata.contestId) },
            { $inc: { participants: 1 } }
          );
          return res.send({transactionId:session.payment_intent,registrationId:result.insertedId});
        }

        res.send(res.send({transactionId:session.payment_intent,contestId:contest._id}));
     
    });
    
    app.get("/registrations/check", async (req, res) => {
      const { contestId, email } = req.query;

      const registration = await registrationsCollection.findOne({
        userEmail: email,
        $or: [
          { contestId: contestId }, // old string data
          { contestId: new ObjectId(contestId) }, // new ObjectId data
        ],
      });

      res.send({ registered: !!registration });
    });
    
    

    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const contest = await contestsCollection.findOne({
        _id: new ObjectId(id),
      });
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

