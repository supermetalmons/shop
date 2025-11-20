implement irl blind boxes nft drop updating existing shop website, and implementing onchain logic and helper firebase cloud functions

# website

connect solana wallet

mint 1-20 boxes in a single tx

there should be a progress bar for how many boxes are minted

when all boxes are minted out, say it, and display there an email subscribtion form that is used in index.html currently — to get notified of a next drop

also when minted out, there should be links to secondary markets: tensor and magic eden

your minted boxes show up in the inventory grid. you get them by requesting a firebase cloud function that would use helius api to get nfts

you can open a box by sending open box tx, when tx succeeds we show 3 dudes. from now on these dudes will show up the same inventory grid with the boxes.

you can select multiple items for delivery (any number of dudes and blind boxes). before sending a delivery request you will save an encrypted address to firebase. then you will send a delivery tx that will burn dudes and boxes cnfts and give corresponding authenticity certificates cnfts.

one last thing possible to do will be entering a code for claiming dudes certificates found in an irl blind box.




# onchain api

- mint tx. 1-20 cnft boxes in a single transaction.

total boxes supply will be 333 boxes. during a development let's test it with 11 boxes.

each box contains 3 dudes. so in prod there will be 999 dudes total, and for test 33 dudes total.

the specific unclaimed dudes ids should be stored onchain.



- open tx. open 1 specific blind box: blind box cnft gets deleted, 3 dudes cfts created with 3 random unclaimed ids. unclaimed ids get updated removing picked ones.



no random picking onchain, only assigning what's picked by cloud function, failing to proceed if was marked as picked already



- request delivery tx

receive a designated certificate cnft in place for each dude cnft or box nft — this happens in the same tx with the delivery payment




# firebase cloud functions

- get nfts: blind boxes, dudes, certificates

- save an encrpypted delivery address: cloud function only receives a string encrypted on a website with TweetNaCl. it should save it in firebase database then corresponding to passed solana address, and an id should get assigned for that delivery address, only one team member will have a key to decrypt these and send to these addresses. country should be stored there unencrypted though, we will need it for delivery price calculation.

- prepare an open box tx: assign random dudes corresponding for that box id deterministically from available dudes ids to avoid it being gamed

- prepare a delivery tx: 

calculate payment cost. based on their destination and shipment size, cloud function decides how much they pay for delivery, and it's cosignature is required for that delivery tx to go through.


after a successful delivery tx we will need to send a transaction assigning dudes ids for that blind box. we can do it batch for all pending boxes too.
so this will be a separate admin cloud function and a separate onchain api. there will be a special logic for blind box delivery assignments favoring already produced items


- prepare irl certificate claim tx: mint specific dudes ids cnfts that we stored for that specific blind box claim code. will also check if the blind box certificate is there on an address that is trying to claim dudes certificates.