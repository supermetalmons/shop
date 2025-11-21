implement irl blind boxes nft drop updating existing shop website, and implementing onchain logic and helper firebase cloud functions


# website

use react and typescript to implement, make it simple and efficient.

connect solana wallet

mint 1-20 boxes in a single tx

there should be a progress bar for how many boxes are minted

when all boxes are minted out, say it, and display there an email subscribtion form that is used in index.html currently — to get notified of a next drop

also when minted out, there should be links to secondary markets: tensor and magic eden

your minted boxes show up in the inventory grid. you get them by requesting a firebase cloud function that would use helius api to get nfts

you can open a box by sending open box tx, when tx succeeds we show 3 dudes. from now on these dudes will show up the same inventory grid with the boxes.

you can select multiple items for delivery (any number of dudes and blind boxes). before sending a delivery request you will save an encrypted address to firebase. then you will send a delivery tx that will burn dudes and boxes cnfts and give corresponding authenticity certificates cnfts.

one last thing possible to do will be entering a code for claiming dudes certificates found in an irl blind box.


# onchain txs

- mint tx. 1-20 cnft boxes in a single transaction.

total boxes supply will be 333 boxes. during the development let's test it with 11 boxes on devnet and then on testnet.

each box contains 3 dudes. so in prod there will be 999 dudes total, and for test 33 dudes total.


- open blind box tx. open 1 specific blind box: blind box cnft gets deleted, 3 dudes cfts created with ids and data prepared by the cloud function. this tx has to be co-signed by a cloud function.


- request delivery tx. pass in blind boxes cnfts and dudes cnfts that need to be deleted. these dudes and boxes are the ones that will be delivered. in exchange for each burned cnft, give user another unique certificate cnft. there will be unique certificate cnft for each separate dude and blind box sent for delivery. this tx should also contain sol payment for amount determined by cloud function depending on destination country.


- claim certificates for irl dudes tx. this will mint specific dudes certificates cnfts after user opens their blind box delivered irl and passes the secret code from the box to the cloud function.



# firebase cloud functions

- get nfts to display in the inventory: blind boxes, dudes, certificates — all displayed in the same grid.

- sign in with solana — get existing profile if any, profile will only have a delivery id now, some unencrypted hint for it like first and last letters, unecrupted country, and an email address. there should be a single email address for a profile and should be possible to have a multiple irl addresses in different countries, should be possible to set a label sting for delivery address like home / etc. making it possible to request deliveries for different addresses while keeping them remembered and available on the next sign in.

- save an encrpypted delivery address: cloud function only receives a string encrypted on a website with TweetNaCl. it should save it in firebase database then corresponding to passed solana address, and an id should get assigned for that delivery address, only one team member will have a key to decrypt these and send to these addresses. country should be stored there unencrypted though, we will need it for delivery price calculation. gotta be signed in somehow to allow saving this corresponding to signed in address.

- prepare an open box tx: assign random dudes corresponding for that box id from available dudes ids. remember dudes ids assigned for that box, so if user does not actually send a prepared tx and this function gets called again for that box, then same dudes ids will be returned.

- prepare a delivery tx: calculate delivery cost. this will be payed in delivery request tx with sol. based on their destination and shipment size, cloud function decides how much they pay for delivery, and it's cosignature is required for that delivery tx to go through. this tx should burn cnfts corresponding to what will be delivered and mint cnfts certificates for these items. when there is a blind box in the delivery, this cloud function should silently assign dudes ids that will be sent in that blind box (same way as dudes get assigned for a box on open tx preparation — make sure not to reassign them if they are already there).

- prepare irl certificate claim tx: mint specific dudes ids cnfts that we stored for that specific blind box claim code. will also check if the blind box certificate is there on an address that is trying to claim dudes certificates so only the person with both secret code and blind box cnft will be able to claim certificates for dudes inside the box.

create secure firebase database rules file as well — we want to keep data private, only exposing cloud functions to be called from the shop website.