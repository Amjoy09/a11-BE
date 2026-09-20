const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const admin = require("firebase-admin");

const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  console.log(req.headers.authorization);
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
  try {
    const idToken = token.split(" ")[1];

    console.log("Before verify");

    const decoded = await admin.auth().verifyIdToken(idToken);

    console.log("Decoded:", decoded.email);

    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.log("Firebase Error:", error);
    res.status(401).send({ message: "Unauthorized Access" });
  }
};

const uri =
  "mongodb+srv://bloodBond_db:SdxZH7wa5yJEvZ6m@cluster0.j1ucna7.mongodb.net/?appName=Cluster0";

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection

    const database = client.db("bloodBond_db");
    const userCollection = database.collection("users");
    const requestCollection = database.collection("requests");
    const paymentCollection = database.collection("payments");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;

      const user = await userCollection.findOne({ email });

      if (user?.role !== "admin") {
        return res.status(403).send({
          message: "Forbidden Access",
        });
      }

      next();
    };

    app.post("/users", async (req, res) => {
      const userInfo = req.body;
      userInfo.role = "donor";
      userInfo.createdAt = new Date();
      const result = await userCollection.insertOne(userInfo);
      res.send(result);
    });

    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.status(200).send(result);
    });

    app.get("/users/role/:email", async (req, res) => {
      const { email } = req.params;
      const query = { email: email };
      const result = await userCollection.findOne(query);
      res.send(result);
    });

    app.patch(
      "/update/user/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { email, status } = req.query;
        const query = { email: email };

        const updateStatus = {
          $set: {
            status: status,
          },
        };
        const result = await userCollection.updateOne(query, updateStatus);
        res.send(result);
      },
    );

    app.patch(
      "/update/user/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { email, role } = req.query;

        const query = { email: email };

        const updateRole = {
          $set: {
            role: role,
          },
        };

        const result = await userCollection.updateOne(query, updateRole);

        res.send(result);
      },
    );

    // User Profile API

    app.get("/user-profile", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await userCollection.findOne({ email: email });
      res.send(user);
    });

    // Update user profile API

    app.patch("/user-profile", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;

      const { name, blood, district, upazila, photoURL } = req.body;
      const query = { email: email };
      const updatedDoc = {
        $set: {
          name,
          blood,
          district,
          upazila,
          photoURL,
        },
      };

      const result = await userCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    // Request Related API's

    app.post("/requests", verifyFBToken, async (req, res) => {
      const data = req.body;
      const result = await requestCollection.insertOne(data);
      res.send(result);
    });

    app.get("/request-detail/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = {
        _id: new ObjectId(id),
      };

      const result = await requestCollection.findOne(query);
      res.send(result);
    });

    app.delete("/my-request/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = {
        _id: new ObjectId(id),
        requester_email: req.decoded_email,
      };

      const result = await requestCollection.deleteOne(query);
      res.send(result);
    });

    app.delete(
      "/all-requests/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = {
          _id: new ObjectId(id),
        };

        const result = await requestCollection.deleteOne(query);
        res.send(result);
      },
    );

    app.get("/all-requests", verifyFBToken, verifyAdmin, async (req, res) => {
      const page = Number(req.query.page);
      const size = Number(req.query.size);

      const requests = await requestCollection
        .find()
        .sort({ _id: -1 })
        .limit(size)
        .skip(page * size)
        .toArray();

      const totalRequest = await requestCollection.countDocuments();

      res.send({ result: requests, totalRequest });
    });

    app.get("/my-request", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const query = { requester_email: email };
      const size = Number(req.query.size);
      const page = Number(req.query.page);

      const result = await requestCollection
        .find(query)
        .sort({ _id: -1 })
        .limit(size)
        .skip(size * page)
        .toArray();

      const totalRequest = await requestCollection.countDocuments(query);

      res.send({ result, totalRequest });
    });

    app.get("/donation-requests", async (req, res) => {
      const page = Number(req.query.page);
      const size = Number(req.query.size);

      const blood = req.query.blood;
      const district = req.query.district;
      const upazila = req.query.upazila;

      const query = {
        donation_status: {
          $in: ["pending", "inprogress"],
        },
      };

      if (blood) {
        query.blood_group = blood;
      }

      if (district) {
        query.recipient_district = district;
      }

      if (upazila) {
        query.recipient_upazila = upazila;
      }

      const result = await requestCollection
        .find(query)
        .sort({ _id: -1 })
        .skip(page * size)
        .limit(size)
        .toArray();

      const totalRequest = await requestCollection.countDocuments(query);

      res.send({
        result,
        totalRequest,
      });
    });

    app.get("/donor-profile/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await userCollection.findOne(
          {
            _id: new ObjectId(id),
            role: "donor",
            status: "active",
          },
          {
            projection: {
              name: 1,
              blood: 1,
              district: 1,
              upazila: 1,
              status: 1,
            },
          },
        );

        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Failed to load donor" });
      }
    });

    app.patch("/update-request/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const request = await requestCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!request) {
        return res.status(404).send({ message: "Request Not found" });
      }

      if (request.requester_email !== req.decoded_email) {
        return res
          .status(403)
          .send({ message: "Only the request creator can edit request" });
      }

      if (request.donation_status !== "pending") {
        return res
          .status(400)
          .send({ message: "Only pending requests can be edited" });
      }

      const result = await requestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updatedData,
        },
      );

      res.send(result);
    });

    app.patch("/request-accept/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;

      const donorEmail = req.decoded_email;

      const donor = await userCollection.findOne({
        email: donorEmail,
      });

      // if (donor?.role !== "donor") {
      //   return res.status(403).send({
      //     message: "Only donors can accept donation requests",
      //   });
      // }

      const request = await requestCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!request) {
        return res.status(404).send({ message: "Request not found" });
      }

      if (request.donation_status !== "pending") {
        return res.status(400).send({
          message: "Request already accepted",
        });
      }

      const result = await requestCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: {
            donation_status: "inprogress",
            donor_name: donor.name,
            donor_email: donor.email,
          },
        },
      );

      res.send(result);
    });

    app.patch("/request-done/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const userEmail = req.decoded_email;

      const request = await requestCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!request) {
        return res.status(404).send({ message: "Request not found" });
      }

      if (request.donor_email !== userEmail) {
        return res
          .status(403)
          .send({ message: "Only accepted donor can complete donation" });
      }

      if (request.donation_status !== "inprogress") {
        return res.status(400).send({
          message: "Request must be inprogress before marking done",
        });
      }

      const updatedRequest = await requestCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: {
            donation_status: "done",
          },
        },
      );

      res.send(updatedRequest);
    });

    app.patch("/request-cancel/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const userEmail = req.decoded_email;
      const request = await requestCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!request) {
        return res.status(404).send({ message: "Request not found" });
      }

      if (request.donor_email !== userEmail) {
        return res
          .status(403)
          .send({ message: "Only accepted donor can complete donation" });
      }

      if (request.donation_status !== "inprogress") {
        return res.status(400).send({
          message: "Request must be inprogress before canceling the request",
        });
      }

      const updatedRequest = await requestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            donation_status: "pending",
            donor_name: "",
            donor_email: "",
          },
        },
      );

      res.send(updatedRequest);
    });

    app.get("/search-request", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = {};

      if (!query) {
        return;
      }
      if (bloodGroup) {
        query.blood_group = bloodGroup;
      }

      if (district) {
        query.recipient_district = district;
      }

      if (upazila) {
        query.recipient_upazila = upazila;
      }

      const result = await requestCollection.find(query).toArray();

      res.send(result);
    });

    app.get("/search-donors", async (req, res) => {
      try {
        const { bloodGroup, district, upazila } = req.query;

        const query = {
          role: "donor",
          status: "active",
          blood: bloodGroup,
          district: district,
          upazila: upazila,
        };

        const result = await userCollection.find(query).toArray();

        res.send({ result, count: result.length });
      } catch (error) {
        console.log(error);
        res.status(500).send({
          message: "Failed to search donors",
        });
      }
    });

    app.get(
      "/statistics",
      verifyFBToken,

      async (req, res) => {
        const totalUsers = await userCollection.countDocuments();
        const totalRequests = await requestCollection.countDocuments();

        const fundingResult = await paymentCollection
          .aggregate([
            {
              $group: {
                _id: null,
                totalFunding: {
                  $sum: "$amount",
                },
              },
            },
          ])
          .toArray();

        const totalFunding =
          fundingResult.length > 0 ? fundingResult[0].totalFunding : 0;

        res.send({
          totalUsers,
          totalRequests,
          totalFunding,
        });
      },
    );

    // Payment Checkout

    app.post("/create-payment-checkout", async (req, res) => {
      const donationInfo = req.body;
      const amount = parseInt(donationInfo?.donatedAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: "Donation Amount",
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",

        customer_email: donationInfo?.donorEmail,

        metadata: {
          donorName: donationInfo?.donorName,
        },

        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    app.post("/success-payment", async (req, res) => {
      const { session_id } = req.query;
      const session = await stripe.checkout.sessions.retrieve(session_id);

      console.log(session);

      const transactionId = session.payment_intent;

      if (session.payment_status === "paid") {
        const paymentInfo = {
          amount: session.amount_total / 100,
          currency: session.currency,
          donorEmail: session.customer_email,
          transactionId,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
        };

        const result = await paymentCollection.insertOne(paymentInfo);
        return res.send(result);
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("This is Our Last Assignment");
});

app.listen(port, () => {
  console.log(`App is Running on port ${port}`);
});
