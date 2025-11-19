- [ ] connect solana wallet

- [ ] mint 11 boxes. there should be a progress bar or just open / close state. when the mint ends, there should be buttons leading to secondary.

- [ ] your minted boxes show up in the inventory grid

- [ ] open specific boxes one by one. when the box gets opened, there will be a transaction. it will pick 3 random items from the unrevealed pool. we will only show them after tx succeeds

- [ ] select multiple items and request a delivery

- [ ] when someone requests a blind box delivery, we assign their ids immediatelly in that tx picking them from available onchain supply ready hints. when onchain supply hints are empty, then we just pick from the unassigned pool, and these items will need to be produced.

- [ ] shipment gets paid if needed in that same request delivery tx. based on their destination and shipment size, cloud function decides how much they pay for delivery, and it's cosignature is required for that delivery tx to go through.

- [ ] receive a certificate nft in exchange for the dude nft or box nft — this happens in the same tx with the delivery payment

- [ ] securely pass delivery address info — ideally directly to bosch, not keeping it anywhere else

- [ ] so there will be a proxy minter contract with supply logic. it will be called, it will mint one nfts and burn other nfts.

- [ ] get certificates for separate dudes after entering a code from the irl box. for blind box delivery tx, we are writing dudes ids corresponding to that box within an onchain program. then it is possible to extract them as a certificate to someone holding that blind box certificate with an ok from the cloud function. this ok will be provided if there is both password match and that address holds that corresponding box certificate.

- [ ] ideally all the sol should be routed directly to bosch with no storing in between



how do i implement solana program like this? i want items be cnfts. what else do i need? i know there is smth called anchor framework for solana programs, do i need it or is there a simpler valilla way, or do i use something else?

think hard — i don't want an implementation from you, i want a detailed analysis iof options i have for the implemetation to make the good desicion before proceeding with it.